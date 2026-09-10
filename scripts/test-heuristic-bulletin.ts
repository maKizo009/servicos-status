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
import type {
	MovementVector,
	NowcastResult,
	ThreatCell,
} from "../src/radar-analysis.js";

const TARGET = { lat: -25.0244, lon: -50.5847 };

function mov(directionDeg: number, speedKmh: number): MovementVector {
	return {
		directionDeg,
		speedKmh,
		intervalMin: 10,
		dxPx: speedKmh,
		dyPx: 0,
		fromLat: -25.0,
		fromLon: -50.6,
		toLat: -25.0 + speedKmh * 0.01,
		toLon: -50.6,
	};
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

// O IPIRANGA central pertence a Ipiranga/PR (malha IBGE). Aproximando a 60 km/ETA 40 min.
function nowcastCom(
	cell: ThreatCell | null,
	extra: Partial<NowcastResult> = {},
): NowcastResult {
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
				threatCell({
					lat: -25.2,
					lon: -50.7,
					distToTargetKm: 40,
					movement: mov(180, 30),
					threat: {
						bearingFromTargetDeg: 180,
						radialKmh: 20,
						approach: "receding",
						etaMin: null,
					},
				}),
			),
			undefined,
			{ alertLevel: "monitor", nearestThreatKm: 40 },
		);
		expect(b.toLowerCase()).toContain("afastando");
		expect(b.toLowerCase()).toContain("risco direto praticamente nulo");
		expect(b).not.toMatch(/ALERTA/);
	});

	test("aproximando mas LONGE (>200km/ETA>360) → ETA único e honesto, sem 'muitas horas'", () => {
		const b = buildHeuristicBulletin(
			nowcastCom(
				threatCell({
					lat: -24.0,
					lon: -52.0,
					distToTargetKm: 250,
					threat: {
						bearingFromTargetDeg: 0,
						radialKmh: -20,
						approach: "approaching",
						etaMin: 400,
					},
				}),
			),
			undefined,
			{ alertLevel: "monitor", nearestThreatKm: 250 },
		);
		expect(b.toLowerCase?.() ?? b).not.toContain("ALERTA");
		expect(b.toLowerCase?.() ?? b).toContain(
			"longe demais para alerta iminente",
		);
		expect(b).not.toContain("muitas horas");
		expect(b).toMatch(/cerca de 7 horas/);
	});

	test("sem núcleo + ECMWF alto → resumo numérico honesto sem narrativa de núcleo", () => {
		const b = buildHeuristicBulletin(
			nowcastCom(null),
			{ rainProbabilityPct: 70, hourlyForecast: [] },
			{ alertLevel: "monitor", nearestThreatKm: null },
		);
		expect(b).toContain("70%");
		expect(b).toContain("Sem chuva relevante");
		expect(b).not.toMatch(/Núcleo de chuva .* a \d+ km/);
	});

	test("sem núcleo + sem ECMWF → frase curta sem refs", () => {
		const b = buildHeuristicBulletin(nowcastCom(null), undefined, {
			alertLevel: "none",
			nearestThreatKm: null,
		});
		expect(b).toContain("Sem chuva relevante");
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

	test("velocidade ~0 → estacionário (nunca 'deslocando a 0 km/h')", () => {
		const b = buildHeuristicBulletin(
			nowcastCom(threatCell({ movement: mov(45, 0), threat: null })),
			undefined,
			{ alertLevel: "monitor", nearestThreatKm: 60 },
		);
		expect(b).not.toMatch(/a 0 km\/h/);
		expect(b).toContain("estacionário");
	});

	test("local-first: chuva em Ipiranga + núcleo distante → chuva local ABRE o boletim", () => {
		const b = buildHeuristicBulletin(
			nowcastCom(
				threatCell({
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
			),
			{ rainProbabilityPct: 100, hourlyForecast: [] },
			{ alertLevel: "watch", nearestThreatKm: 142 },
			{
				acc1hrMax: 3,
				acc6hrMax: 25,
				acc24hrMax: 41.6,
				condition: "Garoa Moderada",
			},
		);
		expect(b.indexOf("Chove em Ipiranga")).toBeLessThan(
			b.indexOf("Núcleo de chuva"),
		);
		expect(b).toContain("41,6 mm em 24h");
	});

	test("local-first: sem threats + chuva local → boletim é de chuva local, não 'sem chuva'", () => {
		const b = buildHeuristicBulletin(
			nowcastCom(null),
			{ rainProbabilityPct: 100, hourlyForecast: [] },
			{ alertLevel: "none", nearestThreatKm: null },
			{
				acc1hrMax: 1.8,
				acc6hrMax: 25,
				acc24hrMax: 41.6,
				condition: "Garoa Moderada",
			},
		);
		expect(b).toContain("Chove em Ipiranga");
		expect(b).not.toContain("Sem chuva relevante");
	});

	test("local-first: sem chuva local → comportamento antigo (núcleo narra sozinho)", () => {
		const b = buildHeuristicBulletin(
			nowcastCom(threatCell({ lat: -25.2, lon: -50.7, distToTargetKm: 30 })),
			undefined,
			{ alertLevel: "alert", nearestThreatKm: 30 },
			{ acc1hrMax: 0, acc6hrMax: 0, acc24hrMax: 0, condition: "Céu Limpo" },
		);
		expect(b).not.toContain("Chove em Ipiranga");
		expect(b).toContain("Núcleo de chuva");
	});
});
