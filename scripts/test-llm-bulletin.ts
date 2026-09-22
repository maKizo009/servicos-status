/**
 * Testes da Camada B2 — LLM analista (10/09/2026).
 * Prompt carrega todos os números; gate de coerência local barra texto
 * que ignora chuva medida em Ipiranga; cadeia com Muse Spark primeiro.
 */
import { describe, expect, test } from "bun:test";
import type { NowcastBulletinRecord } from "../src/db.js";
import {
	avaliarReuso,
	buildAnalystContext,
	buildAnalystPrompt,
	LLM_CHAIN,
	passaCoerenciaLocal,
} from "../src/llm-bulletin.js";
import type {
	MovementVector,
	NowcastResult,
	ThreatCell,
} from "../src/radar-analysis.js";

function mov(directionDeg: number, speedKmh: number): MovementVector {
	return {
		directionDeg,
		speedKmh,
		intervalMin: 10,
		dxPx: speedKmh,
		dyPx: 0,
		fromLat: -25.0,
		fromLon: -50.6,
		toLat: -25.0,
		toLon: -50.6,
	};
}

function threat(over: Partial<ThreatCell> = {}): ThreatCell {
	return {
		intensity: "heavy",
		pixelCount: 100,
		maxDbz: 52,
		meanDbz: 45,
		centroidX: 100,
		centroidY: 100,
		lat: -25.2,
		lon: -50.7,
		distToTargetKm: 142,
		movement: mov(90, 20),
		threat: {
			bearingFromTargetDeg: 90,
			radialKmh: -20,
			radialFraction: -1,
			approach: "approaching",
			etaMin: 261,
		},
		relevanceZone: "watch",
		...over,
	};
}

function nowcast(cells: ThreatCell[]): NowcastResult {
	return {
		analyzedAt: Date.now(),
		frames: [],
		movement: cells[0]?.movement ?? null,
		currentMaxDbz: 52,
		currentDominant: "heavy",
		nearestCell: cells[0] ?? null,
		threats: cells,
	};
}

describe("cadeia LLM", () => {
	// 21/09/2026: a troca do boletim pra NIM foi erro de leitura de um pedido do Dave
	// ("use o Jev NA OpenRouter") e degradou o produto — em produção o NIM não
	// respondeu e o boletim caiu na heurística. O revert voltou o OpenRouter como
	// principal; este teste ficou apontando pro estado revertido (vermelho desde
	// então) e foi alinhado em 22/09/2026.
	test("OpenRouter primeiro (Muse Spark → Minimax), NIM como reserva", () => {
		expect(LLM_CHAIN[0].provider).toBe("openrouter");
		expect(LLM_CHAIN[0].model).toBe("meta/muse-spark-1.3-contributor");
		expect(LLM_CHAIN[LLM_CHAIN.length - 1]?.provider).toBe("nim");
		expect(LLM_CHAIN[LLM_CHAIN.length - 1]?.model).toBe("openai/gpt-oss-20b");
	});
});

describe("buildAnalystPrompt", () => {
	test("carrega chuva local + núcleo + ECMWF, sem jargão de instrução vazada", () => {
		const { analyst } = buildAnalystContext(nowcast([threat()]), {
			local: {
				acc1hrMax: 3,
				acc6hrMax: 25,
				acc24hrMax: 41.6,
				condition: "Garoa Moderada",
			},
			condition: "Garoa Moderada",
			ecmwfPct: 100,
			ecmwfProx6hMm: 4.2,
			alertLevel: "watch",
			hidroWatch: false,
			avisosOficiais: [],
		});
		const p = buildAnalystPrompt(analyst);
		expect(p).toContain("41");
		expect(p).toContain("142 km");
		expect(p).toContain("100%");
		expect(p).toContain("600 caracteres");
		expect(p).not.toMatch(/fonte de verdade/i);
	});
	test("sem ameaças → declara radar limpo em vez de inventar núcleo", () => {
		const { analyst } = buildAnalystContext(nowcast([]), {
			local: {
				acc1hrMax: 0,
				acc6hrMax: 0,
				acc24hrMax: 0,
				condition: "Céu Limpo",
			},
			condition: "Céu Limpo",
			ecmwfPct: 10,
			ecmwfProx6hMm: 0,
			alertLevel: "none",
			hidroWatch: false,
			avisosOficiais: [],
		});
		const p = buildAnalystPrompt(analyst);
		expect(p).toContain("nenhum núcleo");
	});
});

describe("passaCoerenciaLocal", () => {
	test("chovendo + texto sem menção → rejeita", () => {
		expect(
			passaCoerenciaLocal(
				"Núcleo distante se aproxima, sem risco.",
				"Chove em Ipiranga agora (41,6 mm em 24h).",
			),
		).toBe(false);
	});
	test("chovendo + texto com mm → aceita", () => {
		expect(
			passaCoerenciaLocal(
				"Chove em Ipiranga agora (41,6 mm em 24h). Núcleo a 142 km.",
				"Chove em Ipiranga agora.",
			),
		).toBe(true);
	});
	test("sem chuva local → sempre passa", () => {
		expect(passaCoerenciaLocal("Qualquer coisa.", null)).toBe(true);
	});
});

/**
 * Incidente 22/09/2026: o "Boletim IA" do Monitor Ipiranga serviu por mais de um
 * dia o texto "Chove em Ipiranga agora, com 13,6 mm na última hora" com o
 * pluviômetro zerado e previsão de 91%. Duas causas somadas: o ciclo regravava o
 * texto reusado com timestamp novo (cache de 30 min nunca expirava) e o gate
 * comparava "presença de frase" em vez de MEDIÇÃO.
 */
describe("avaliarReuso do boletim", () => {
	const agora = Date.UTC(2026, 8, 22, 11, 0, 0);
	const semChuva = {
		acc1hrMax: 0,
		acc6hrMax: 0,
		acc24hrMax: 37.4,
		condition: "Garoa Moderada",
	};
	const cached = (
		over: Partial<NowcastBulletinRecord> = {},
	): NowcastBulletinRecord => ({
		id: 1765,
		text: "Sem chuva medida em Ipiranga nas últimas horas; rios em atenção.",
		source: "openrouter",
		generatedAt: agora - 8 * 60_000,
		contextKey: "abc-10",
		...over,
	});

	test("texto diz que chove agora e o pluviômetro está zerado → NÃO reusa", () => {
		const r = avaliarReuso({
			cached: cached({
				text: "Chove em Ipiranga agora, com 13,6 mm na última hora e 14 mm nas últimas 24 horas.",
			}),
			local: semChuva,
			nowcast: nowcast([]),
			chaveCenario: "outro-11",
			agora,
		});
		expect(r.reusar).toBe(false);
		expect(r.motivo).toMatch(/parou de chover/);
	});

	test("cenário igual → reusa", () => {
		const r = avaliarReuso({
			cached: cached(),
			local: semChuva,
			nowcast: nowcast([]),
			chaveCenario: "abc-10",
			agora,
		});
		expect(r.reusar).toBe(true);
		expect(r.motivo).toMatch(/mesmo cenário/);
	});

	test("cenário mudou e texto já tem mais de 12 min → NÃO reusa", () => {
		const r = avaliarReuso({
			cached: cached({ generatedAt: agora - 20 * 60_000 }),
			local: semChuva,
			nowcast: nowcast([]),
			chaveCenario: "outro-11",
			agora,
		});
		expect(r.reusar).toBe(false);
		expect(r.motivo).toMatch(/cenário mudou/);
	});

	test("cenário mudou mas o texto é recente (<12 min) → reusa (trava de custo)", () => {
		const r = avaliarReuso({
			cached: cached({ generatedAt: agora - 5 * 60_000 }),
			local: semChuva,
			nowcast: nowcast([]),
			chaveCenario: "outro-11",
			agora,
		});
		expect(r.reusar).toBe(true);
		expect(r.motivo).toMatch(/trava de custo/);
	});

	test("boletim da heurística nunca é reusado", () => {
		const r = avaliarReuso({
			cached: cached({ source: "heuristic" }),
			local: semChuva,
			nowcast: nowcast([]),
			chaveCenario: "abc-10",
			agora,
		});
		expect(r.reusar).toBe(false);
		expect(r.motivo).toMatch(/heurística/);
	});

	test("TTL vencido → NÃO reusa", () => {
		const r = avaliarReuso({
			cached: cached({ generatedAt: agora - 40 * 60_000 }),
			local: semChuva,
			nowcast: nowcast([]),
			chaveCenario: "abc-10",
			agora,
		});
		expect(r.reusar).toBe(false);
		expect(r.motivo).toMatch(/TTL/);
	});

	test("texto cita núcleo e o radar está limpo → NÃO reusa", () => {
		const r = avaliarReuso({
			cached: cached({ text: "Núcleo de chuva forte a 120 km de Ipiranga." }),
			local: semChuva,
			nowcast: nowcast([]),
			chaveCenario: "abc-10",
			agora,
		});
		expect(r.reusar).toBe(false);
		expect(r.motivo).toMatch(/radar está limpo/);
	});

	test("boletim antigo sem context_key (pré-migração) ainda pode ser reusado", () => {
		const r = avaliarReuso({
			cached: cached({ contextKey: null }),
			local: semChuva,
			nowcast: nowcast([]),
			chaveCenario: "outro-11",
			agora,
		});
		expect(r.reusar).toBe(true);
	});
});
