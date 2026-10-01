/**
 * Testes da Camada B2 — LLM analista (10/09/2026).
 * Prompt carrega todos os números; gate de coerência local barra texto
 * que ignora chuva medida em Ipiranga; cadeia com Muse Spark primeiro.
 */
import { describe, expect, test } from "bun:test";
import type { NowcastBulletinRecord } from "../src/db.js";
import { fraseChuvaLocal, validateBulletinAgainstVerdict } from "../src/nowcast-vlm.js";
import {
	avaliarReuso,
	buildAnalystContext,
	buildAnalystPrompt,
	LLM_CHAIN,
	passaCoerenciaLocal,
	tetoDoModeloNaCadeia,
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
	/**
	 * Caso real 01/10/2026 (ciclo 15:50): o prompt listava SOLO como
	 * "Castro (7 km, INMET)" — a distância da ESTAÇÃO ao centro da cidade.
	 * O modelo copiou para o boletim ("Em Castro, a 7 km") e o gate de
	 * distâncias rejeitou o texto (Castro fica a 75 km de Ipiranga; nenhuma
	 * entidade mede 7 km) → cadeia esgotou → heurística → watchdog alertou.
	 * O número não deve aparecer no prompt: ele não é distância de Ipiranga.
	 */
	test("SOLO não expõe distância da estação como se fosse de Ipiranga", () => {
		const { analyst } = buildAnalystContext(nowcast([threat()]), {
			local: {
				acc1hrMax: 0,
				acc6hrMax: 7,
				acc24hrMax: 13.6,
				condition: "Encoberto",
			},
			condition: "Encoberto",
			ecmwfPct: 67,
			ecmwfProx6hMm: 1.8,
			alertLevel: "monitor",
			hidroWatch: false,
			avisosOficiais: [],
			solo: [
				{
					cidade: "Castro",
					distanciaKm: 7,
					estacao: "Castro",
					rede: "INMET",
					atualizacao: "01/10/26 12:00",
					frescorMin: 30,
					stale: false,
					rajada1hKmh: null,
					rajada24hKmh: null,
					quedaPressao24Hpa: 1.8,
					chuva1hMm: 0,
					chuva24hMm: 26.2,
					ventoKmh: null,
					ventoDirDeg: null,
				},
			],
		});
		const p = buildAnalystPrompt(analyst);
		expect(p).toContain("Castro (estação INMET)");
		expect(p).not.toMatch(/Castro \(7 km/);
		expect(p).toContain("pressão caiu 1.8 hPa");
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

	test("texto diz que chove agora com 6h acumulado e 1h zerada → NÃO reusa", () => {
		// Caso exato do incidente: "Chove em Ipiranga agora, com 5,8 mm em 6 horas"
		// com a última hora em 0,0 mm. Acumulado não é chuva acontecendo.
		const r = avaliarReuso({
			cached: cached({
				text: "Chove em Ipiranga agora, com 5,8 mm em 6 horas e 37,4 mm em 24 horas nos pluviômetros da cidade.",
			}),
			local: { ...semChuva, acc6hrMax: 5.8 },
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

/**
 * O gate de ETA comparava toda duração citada com UM único `verdict.etaMin`.
 * O texto cita uma ETA por entidade (área + núcleo, como o prompt entrega), então
 * boletim correto era reprovado em série e o card caía na heurística (22/09/2026).
 */
describe("validateBulletinAgainstVerdict: ETA por entidade", () => {
	const verdict = {
		bearingFromTargetDeg: 0,
		radialKmh: -60,
		radialFraction: -1,
		approach: "approaching" as const,
		etaMin: 60,
	};
	const texto =
		"Choveu em Ipiranga nas últimas horas, 5,0 mm em 6 h. Um núcleo de chuva forte a 120 km chega em cerca de 1 hora; uma área de chuva moderada em Ibiporã/PR, a 209 km, pode chegar em cerca de 5 horas.";
	const opts = { alertLevel: "monitor" as const, nearestThreatKm: 120 };

	test("cada ETA citada bate com uma entidade do contexto → aceita", () => {
		expect(
			validateBulletinAgainstVerdict(texto, verdict, undefined, {
				...opts,
				etasValidas: [60, 300],
			}),
		).toBe(true);
	});

	test("sem a lista de ETAs (comportamento antigo) → reprova: era o bug", () => {
		// A área (300 min) comparada só com o núcleo (60 min) divergia 400%.
		expect(
			validateBulletinAgainstVerdict(texto, verdict, undefined, opts),
		).toBe(false);
	});

	test("ETA que não é de nenhuma entidade → reprova de verdade", () => {
		expect(
			validateBulletinAgainstVerdict(texto, verdict, undefined, {
				...opts,
				etasValidas: [600, 700],
			}),
		).toBe(false);
	});
});

/**
 * O LLM não inventou "chove agora": ele repetiu o contexto, que afirmava
 * "CHUVA EM IPIRANGA AGORA" só porque o acumulado de 6 h passava de 5 mm.
 */
describe("fraseChuvaLocal (tempo verbal)", () => {
	const base = {
		acc1hrMax: 0,
		acc6hrMax: 5.8,
		acc24hrMax: 37.4,
		condition: "Garoa Moderada",
	};

	test("acumulado de 6h com a última hora zerada NÃO vira 'chove agora'", () => {
		const f = fraseChuvaLocal(base);
		expect(f).toMatch(/choveu/i);
		expect(f).not.toMatch(/chove em ipiranga agora/i);
	});

	test("medição na última hora vira 'chove agora'", () => {
		expect(fraseChuvaLocal({ ...base, acc1hrMax: 2.4 })).toMatch(
			/chove em ipiranga agora/i,
		);
	});

	test("sem sinal nenhum → null (nada a afirmar)", () => {
		expect(
			fraseChuvaLocal({
				acc1hrMax: 0,
				acc6hrMax: 0,
				acc24hrMax: 0,
				condition: "Céu Limpo",
			}),
		).toBeNull();
	});
});

describe("tetoDoModeloNaCadeia (reserva do último modelo)", () => {
	const opts = {
		tetoModeloMs: 15_000,
		reservaUltimoMs: 10_000,
		tetoGlobalMs: 30_000,
	};

	test("cenário real 01/10: 2 OpenRouter no teto → NIM ainda recebe fatia", () => {
		// muse-spark estoura os 15 s; minimax herda 15 s restantes e estoura
		// também; sobram 10 s — o NIM (último) entra com eles em vez de ser
		// bloqueado pelo "restante < 3 s" antigo.
		expect(tetoDoModeloNaCadeia(0, 3, 30_000, opts)).toBe(15_000);
		expect(tetoDoModeloNaCadeia(1, 3, 15_000, opts)).toBe(5_000);
		expect(tetoDoModeloNaCadeia(2, 3, 10_000, opts)).toBe(10_000);
	});

	test("último bloqueado só com < 3 s restantes", () => {
		expect(tetoDoModeloNaCadeia(2, 3, 2_999, opts)).toBeNull();
	});

	test("não-último não invade a reserva do último", () => {
		// restante 12,9 s: precisaria deixar 10 s + 3 s pro último → bloqueado
		expect(tetoDoModeloNaCadeia(1, 3, 12_999, opts)).toBeNull();
	});

	test("modelo único = é o último, usa o que sobrar", () => {
		expect(tetoDoModeloNaCadeia(0, 1, 22_000, opts)).toBe(22_000);
	});

	test("cadeia saudável: 1º responde rápido, 2º mantém teto cheio", () => {
		// restante 29 s após resposta de 1 s → teto = min(30, 15, 29-10) = 15
		expect(tetoDoModeloNaCadeia(1, 3, 29_000, opts)).toBe(15_000);
	});
});
