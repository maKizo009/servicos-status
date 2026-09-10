/**
 * Testes da evolução do radar (10/09/2026):
 * tiles 512 sem smoothing + heurística anti-alucinação.
 *
 * - fmtEta: gente não pensa em "337 minutos".
 * - assessAllThreats: microborrão não vira threat.
 * - pixelToLatLon: exata para qualquer tileSize.
 * - Boletim: ETA em horas + honestidade de alcance (>300 km).
 */
import { describe, expect, test } from "bun:test";
import { buildHeuristicBulletin } from "../src/nowcast-vlm.js";
import type {
	MovementVector,
	NowcastResult,
	RainCell,
	ThreatCell,
} from "../src/radar-analysis.js";
import {
	assessAllThreats,
	fmtEta,
	pixelToLatLon,
	THREAT_MIN_PIXELS_AT_256,
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

function cell(over: Partial<RainCell> = {}): RainCell {
	return {
		intensity: "heavy",
		pixelCount: 100,
		maxDbz: 52,
		meanDbz: 45,
		centroidX: 100,
		centroidY: 100,
		lat: -25.2,
		lon: -50.7,
		...over,
	};
}

function threat(over: Partial<ThreatCell> = {}): ThreatCell {
	const c = cell(over);
	return {
		...c,
		distToTargetKm: 60,
		movement: mov(0, 30),
		threat: {
			bearingFromTargetDeg: 0,
			radialKmh: -25,
			approach: "approaching",
			etaMin: 40,
		},
		relevanceZone: "alert",
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

describe("fmtEta (ETA para gente)", () => {
	test("minutos abaixo de 120", () => {
		expect(fmtEta(40)).toBe("~40 min");
		expect(fmtEta(119)).toBe("~119 min");
	});
	test("horas a partir de 120", () => {
		expect(fmtEta(261)).toContain("hora");
		expect(fmtEta(337)).toBe("cerca de 6 horas");
		expect(fmtEta(150)).toContain("2");
	});
	test("nulo/inválido não quebra", () => {
		expect(fmtEta(null)).toBe("tempo indeterminado");
		expect(fmtEta(undefined)).toBe("tempo indeterminado");
	});
});

describe("pixelToLatLon por tileSize", () => {
	test("512px no centro do tile = mesmo ponto que 256px", () => {
		const a = pixelToLatLon({ z: 7, x: 46, y: 73 }, 128, 128, 256);
		const b = pixelToLatLon({ z: 7, x: 46, y: 73 }, 256, 256, 512);
		expect(Math.abs(a.lat - b.lat)).toBeLessThan(1e-9);
		expect(Math.abs(a.lon - b.lon)).toBeLessThan(1e-9);
	});
});

describe("assessAllThreats anti-microborrão", () => {
	test("núcleo heavy com 3 px não vira threat", () => {
		const out = assessAllThreats([cell({ pixelCount: 3 })], -25.0244, -50.5847);
		expect(out.length).toBe(0);
	});
	test(`piso é ${THREAT_MIN_PIXELS_AT_256} px @256 e escala x4 @512`, () => {
		const ok256 = assessAllThreats(
			[cell({ pixelCount: 12 })],
			-25.0244,
			-50.5847,
			256,
		);
		expect(ok256.length).toBe(1);
		const drop512 = assessAllThreats(
			[cell({ pixelCount: 12 })],
			-25.0244,
			-50.5847,
			512,
		);
		expect(drop512.length).toBe(0);
		const ok512 = assessAllThreats(
			[cell({ pixelCount: 48 })],
			-25.0244,
			-50.5847,
			512,
		);
		expect(ok512.length).toBe(1);
	});
});

describe("boletim anti-alucinação", () => {
	test("ETA 261 min aparece em horas, não '261 min'", () => {
		const b = buildHeuristicBulletin(
			nowcast([
				threat({
					lat: -24.0,
					lon: -52.0,
					distToTargetKm: 142,
					threat: {
						bearingFromTargetDeg: 0,
						radialKmh: -20,
						approach: "approaching",
						etaMin: 261,
					},
				}),
			]),
			{ rainProbabilityPct: 100, hourlyForecast: [] },
			{ alertLevel: "watch", nearestThreatKm: 142 },
			{ acc1hrMax: 0, acc6hrMax: 0, acc24hrMax: 0, condition: "Céu Limpo" },
		);
		expect(b).not.toContain("261 min");
		expect(b).toMatch(/hora/);
	});
	test("núcleo a 419 km confessa alcance limite", () => {
		const b = buildHeuristicBulletin(
			nowcast([
				threat({
					lat: -22.0,
					lon: -47.0,
					distToTargetKm: 419,
					threat: {
						bearingFromTargetDeg: 0,
						radialKmh: -20,
						approach: "approaching",
						etaMin: 337,
					},
				}),
			]),
			{ rainProbabilityPct: 20, hourlyForecast: [] },
			{ alertLevel: "monitor", nearestThreatKm: 419 },
			{ acc1hrMax: 0, acc6hrMax: 0, acc24hrMax: 0, condition: "Céu Limpo" },
		);
		expect(b).toContain("confiança baixa");
	});
	test("chuva forte sobre Ipiranga + pluviômetro zerado = eco suspeito", () => {
		const b = buildHeuristicBulletin(
			nowcast([
				threat({
					intensity: "extreme",
					lat: -25.05,
					lon: -50.6,
					distToTargetKm: 8,
					movement: mov(0, 25),
					threat: {
						bearingFromTargetDeg: 0,
						radialKmh: -25,
						approach: "approaching",
						etaMin: 20,
					},
				}),
			]),
			{ rainProbabilityPct: 30, hourlyForecast: [] },
			{ alertLevel: "alert", nearestThreatKm: 8 },
			{ acc1hrMax: 0, acc6hrMax: 0, acc24hrMax: 0, condition: "Céu Limpo" },
		);
		expect(b).toContain("pluviômetros da cidade ainda não registram chuva");
	});
});
