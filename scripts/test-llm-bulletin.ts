/**
 * Testes da Camada B2 — LLM analista (10/09/2026).
 * Prompt carrega todos os números; gate de coerência local barra texto
 * que ignora chuva medida em Ipiranga; cadeia com Muse Spark primeiro.
 */
import { describe, expect, test } from "bun:test";
import {
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
	// OpenRouter aposentado em 21/09/2026 (pedido do Dave). A cadeia agora é NIM
	// (verificado vivo no bun com o prompt real) e a heurística é a reserva final,
	// que é implícita: tryLlmBulletin devolve null e o chamador cai nela.
	test("NIM primeiro, sem slug do OpenRouter, heurística por último (implícita)", () => {
		expect(LLM_CHAIN[0].provider).toBe("nim");
		expect(LLM_CHAIN[0].model).toBe("openai/gpt-oss-20b");
		for (const e of LLM_CHAIN) expect(e.model).not.toMatch(/^(meta|minimax|tencent)\//);
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
