/**
 * Testes da heurística determinística (Camada B SEM LLM — 2026-08-18).
 *
 * O boletim agora é 100% template a partir da Camada A: veredito de ameaça,
 * município real (malha IBGE), distância até Ipiranga, nível de alerta e
 * conciliação ECMWF. Estes testes garantem que o texto entregue informação
 * CORRETA (ninguém na chain de IA pra validar depois).
 */
import { describe, expect, test } from "bun:test";
import { buildHeuristicBulletin } from "../src/nowcast-vlm.js";
import type { NowcastResult, ThreatCell, MovementVector } from "../src/radar-analysis.js";

const TARGET = { lat: -25.0244, lon: -50.5847 };

function mov(directionDeg: number, speedKmh: number): MovementVector {
	return { directionDeg, speedKmh, intervalMin: 10 };
}

function threatCell(over: Partial<ThreatCell>): ThreatCell {
	return {
		intensity: "heavy",
		pixelCount: 100,
		maxDbz: 52,
		meanDbz: 45,
		centroidX: 100,
		centroidY: 100,
		lat: -25.0,
		lon: -50.6,
		distToTargetKm: 60,
		movement: mov(0, 30),
		threat: { bearingFromTargetDeg: 0, radialKmh: -25, approach: "approaching", etaMin: 40 },
		relevanceZone: "alert",
		...over,
	};
}

// O IPIRANGA central pertence a Ipiranga/PR (malha IBGE). Aproximando a 60 km/ETA 40 min.
function nowcastCom(cell: ThreatCell | null, extra: Partial<NowcastResult> = {}): NowcastResult {
	return {
		analyzedAt: Date.now(),
		frames: [],
		movement: cell?.movement ?? null,
		currentMaxDbz: cell?.maxDbz ?? -100,
		currentDominant: (cell?.intensity ?? "none") as any,
		nearestCell: cell,
		threats: cell ? [cell] : [],
		...extra,
	};
}

describe("Heurística determinística (sem LLM)", () => {
	test("aproximando em zona ALERT → cita alerta real + município + distância", () => {
		const b = buildHeuristicBulletin(
			nowcastCom(threatCell({ lat: -25.2, lon: -50.7, distToTargetKm: 30 })),
			undefined,
			{ alertLevel: "alert", nearestThreatKm: 30 },
		);
		expect(b).toContain("ALERTA");
		expect(b).toContain("30 km"); // distância de Ipiranga
		expect(b).toContain("aproximando"); // veredito determinístico
		expect(b.toLowerCase()).toMatch(/ipiranga|pr/); // município real citado
	});

	test("afastando → deixa claro risco nulo, sem alarme", () => {
		const b = buildHeuristicBulletin(
			nowcastCom(
				threatCell({ lat: -25.2, lon: -50.7, distToTargetKm: 40, movement: mov(180, 30),
					threat: { bearingFromTargetDeg: 180, radialKmh: 20, approach: "receding", etaMin: null } }),
			),
			undefined,
			{ alertLevel: "monitor", nearestThreatKm: 40 },
		);
		expect(b.toLowerCase()).toContain("afastando");
		expect(b.toLowerCase()).toContain("risco direto praticamente nulo");
		expect(b).not.toMatch(/ALERTA/);
	});

	test("aproximando mas LONGE (>200km/ETA>360) → não há alerta iminente", () => {
		const b = buildHeuristicBulletin(
			nowcastCom(
				threatCell({ lat: -24.0, lon: -52.0, distToTargetKm: 250,
					threat: { bearingFromTargetDeg: 0, radialKmh: -20, approach: "approaching", etaMin: 400 } }),
			),
			undefined,
			{ alertLevel: "monitor", nearestThreatKm: 250 },
		);
		expect(b.toLowerCase?.() ?? b).not.toContain("ALERTA");
		expect(b.toLowerCase?.() ?? b).toContain("não há alerta iminente");
	});

	test("sem núcleo + ECMWF alto → cita divergência honesta sem afirmar certeza", () => {
		const b = buildHeuristicBulletin(
			nowcastCom(null),
			{ rainProbabilityPct: 70, hourlyForecast: [] },
			{ alertLevel: "monitor", nearestThreatKm: null },
		);
		expect(b).toContain("70%");
		expect(b).toContain("não mostra núcleos em movimento");
	});

	test("sem núcleo + sem ECMWF → frase curta sem refs", () => {
		const b = buildHeuristicBulletin(nowcastCom(null), undefined, { alertLevel: "none", nearestThreatKm: null });
		expect(b).toContain("Sem núcleos");
		expect(b).not.toContain("ECMWF");
	});

	test("ECMWF >=50% com núcleo sem movimento → cita divergência", () => {
		const b = buildHeuristicBulletin(
			nowcastCom(threatCell({ movement: mov(0, 0), threat: null })),
			{ rainProbabilityPct: 55, hourlyForecast: [] },
			{ alertLevel: "monitor", nearestThreatKm: 60 },
		);
		expect(b).toContain("55%");
		expect(b).toContain("não mostra núcleos em movimento");
	});
});
