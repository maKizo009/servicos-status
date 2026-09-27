/**
 * Proximidade do núcleo no radar (incidente ao vivo 27/09/2026).
 *
 * Relato do dono: o radar mostrava núcleo de chuva forte a ~50 km de Ipiranga,
 * mas o card anunciava "Núcleo de chuva forte a ~222 km da cidade, vindo para a
 * região" e NENHUM alerta (nem amarelo) aparecia.
 *
 * Dois defeitos independentes:
 *  1. `state.nearestThreatKm` usava `nowcast.threats[0]` — a lista vem ordenada
 *     por PERIGO (aproximando com menor ETA primeiro), não por distância. O card
 *     anunciava o núcleo mais PERIGOSO da lista, a 222/566 km, com um extreme a
 *     73,7 km de Ipiranga.
 *  2. Núcleo extreme/heavy PERTO mas com veredito `crossing`/`receding` caía em
 *     `monitor` (nenhum alerta, nenhum push). Agora é VIGILÂNCIA (amarelo): não
 *     afirmamos que vem, mas chuva forte a poucos km não fica invisível.
 *
 * Os valores abaixo são a lista REAL de ameaças do payload de produção no
 * momento do incidente (intensidade, distância medida e veredito de movimento).
 */
import { describe, expect, test } from "bun:test";
import {
	RELEVANCE_ZONES,
	classifyRelevanceZone,
	nearestStrongThreat,
	nucleoSeveroIminente,
	type ThreatCell,
} from "../src/radar-analysis.js";

/** (intensidade, km, veredito, velocidade km/h) — payload real de 27/09/2026. */
const AMEACAS_REAIS: [string, number, "approaching" | "receding" | "crossing" | null, number | null][] =
	[
		["heavy", 566.3, "approaching", 125.6],
		["extreme", 507.1, "approaching", 80.7],
		["extreme", 547.0, "approaching", 97.2],
		["extreme", 759.4, "approaching", 74.5],
		["heavy", 512.8, "approaching", 52.4],
		["heavy", 732.5, "approaching", 86.8],
		["moderate", 861.0, "approaching", 47.3],
		["heavy", 817.0, "approaching", 38.1],
		["moderate", 46.5, null, null],
		["extreme", 73.7, "crossing", 112.3],
		["extreme", 87.2, "crossing", 96.8],
		["extreme", 135.6, "crossing", 62.7],
		["extreme", 212.2, "crossing", 54.9],
		["extreme", 354.8, "crossing", 9.3],
		["moderate", 453.7, "crossing", 116.9],
		["heavy", 483.7, "crossing", 29.2],
		["heavy", 606.4, null, null],
		["heavy", 719.0, null, null],
		["heavy", 776.0, null, null],
		["heavy", 791.6, null, null],
		["heavy", 881.4, null, null],
	];

const celula = (
	[tmpI, km, ap, spd]: (typeof AMEACAS_REAIS)[number],
	i: number,
): ThreatCell => ({
	id: `t${i}`,
	intensity: tmpI as ThreatCell["intensity"],
	pixelCount: 100,
	maxDbz: 58,
	meanDbz: 30,
	centroidX: 0,
	centroidY: 0,
	lat: -25.4,
	lon: -51.1,
	kind: "nucleo",
	distToTargetKm: km,
	// movimento REAL do payload: sem ele a regra de proximidade não é exercitada
	// no caminho que a produção usa (crossing COM velocidade medida).
	movement:
		spd != null
			? {
					directionDeg: 347,
					speedKmh: spd,
					intervalMin: 10,
					dxPx: -7,
					dyPx: -33,
					fromLat: -25.57,
					fromLon: -51.14,
					toLat: -25.41,
					toLon: -51.18,
				}
			: null,
	threat: ap
		? {
				bearingFromTargetDeg: 54,
				radialKmh: ap === "approaching" ? -80 : ap === "receding" ? 80 : 0,
				radialFraction: ap === "crossing" ? 0.1 : 0.9,
				approach: ap,
				etaMin: ap === "approaching" ? 55 : null,
			}
		: null,
	relevanceZone: "monitor",
});

const REAIS = AMEACAS_REAIS.map(celula);

describe("distância anunciada é a do núcleo forte MAIS PRÓXIMO", () => {
	test("lista real: 73,7 km (extreme) — e NÃO os 566 km do primeiro da lista", () => {
		const t = nearestStrongThreat(REAIS);
		expect(t?.distToTargetKm).toBe(73.7);
		expect(t?.intensity).toBe("extreme");
		// o defeito antigo: `threats[0]` era o heavy a 566 km
		expect(REAIS[0].distToTargetKm).toBe(566.3);
	});

	test("área MODERADA a 46,5 km não é anunciada como 'chuva forte'", () => {
		// A frase do card diz "núcleo de chuva FORTE": o mais próximo com essa
		// intensidade é o extreme de 73,7 km, não a área moderada de 46,5 km.
		expect(nearestStrongThreat(REAIS)?.distToTargetKm).not.toBe(46.5);
	});

	test("sem nenhum forte, cai no mais próximo de qualquer intensidade", () => {
		const fracos = REAIS.filter((t) => t.intensity === "moderate");
		expect(nearestStrongThreat(fracos)?.distToTargetKm).toBe(46.5);
	});

	test("lista vazia devolve null", () => {
		expect(nearestStrongThreat([])).toBe(null);
	});
});

describe("núcleo forte e PERTO vira vigilância (amarelo), não 'monitor'", () => {
	test("o caso do incidente: extreme a 73,7 km passando de lado → watch", () => {
		expect(classifyRelevanceZone(73.7, "crossing", null, "extreme", 112.3)).toBe(
			"watch",
		);
	});

	test("na lista real, exatamente UM núcleo sai da zona morta", () => {
		const zonas = REAIS.map((t) =>
			classifyRelevanceZone(
				t.distToTargetKm,
				t.threat?.approach ?? null,
				t.threat?.etaMin ?? null,
				t.intensity,
				t.movement?.speedKmh ?? null,
			),
		);
		expect(zonas.filter((z) => z === "watch").length).toBe(1); // o de 73,7 km
		expect(zonas.filter((z) => z === "alert").length).toBe(0); // nada iminente
		expect(zonas[9]).toBe("watch"); // índice do extreme de 73,7 km
	});

	test("raio: extreme ≤80 km e heavy ≤40 km (metade) — fora disso, monitor", () => {
		expect(RELEVANCE_ZONES.nearStrongKm).toBe(80);
		expect(classifyRelevanceZone(80, "crossing", null, "extreme", 60)).toBe("watch");
		expect(classifyRelevanceZone(81, "crossing", null, "extreme", 60)).toBe("monitor");
		expect(classifyRelevanceZone(40, null, null, "heavy", null)).toBe("watch");
		expect(classifyRelevanceZone(41, null, null, "heavy", null)).toBe("monitor");
		expect(classifyRelevanceZone(30, null, null, "moderate", null)).toBe("monitor");
	});

	test("receding perto segue a doutrina: MONITOR (está indo embora)", () => {
		// Doutrina do incidente 12/08/2026 preservada — a regra nova não a toca.
		expect(classifyRelevanceZone(30, "receding", null, "extreme", 90)).toBe("monitor");
	});

	test("sem movimento medido (célula nova) perto = vigilância", () => {
		// Núcleo que surge e se intensifica entre frames: sem veredito de rumo,
		// mas a 60 km e extreme — o cidadão vê amarelo, não "monitor".
		expect(classifyRelevanceZone(60, null, null, "extreme", null)).toBe("watch");
	});
});

describe("núcleo de tempestade iminente promove a laranja (caso ao vivo 27/09)", () => {
	/** (intensidade, km, zona, kind, ETA min) — payload real no momento do relato. */
	const CENA: [string, number, "alert" | "watch" | "monitor", "nucleo" | "area", number | null][] = [
		["moderate", 39.3, "alert", "area", 56.8],
		["extreme", 66.7, "alert", "nucleo", 94.1],
		["extreme", 82.2, "watch", "nucleo", 169.3],
	];
	const cena = CENA.map(([i, km, zona, kind, eta], k) => ({
		...celula([i, km, "approaching", 90], k),
		kind: kind as ThreatCell["kind"],
		relevanceZone: zona as ThreatCell["relevanceZone"],
		threat: {
			bearingFromTargetDeg: 54,
			radialKmh: -80,
			radialFraction: 0.9,
			approach: "approaching" as const,
			etaMin: eta,
		},
	})) as ThreatCell[];

	test("a ÁREA que chega antes não pode mascarar o núcleo extreme atrás dela", () => {
		const s = nucleoSeveroIminente(cena);
		expect(s?.intensity).toBe("extreme");
		expect(s?.distToTargetKm).toBe(66.7);
		// o defeito antigo: o primeiro da lista (por ETA) era a área moderada
		expect(cena[0].kind).toBe("area");
	});

	test("só área na zona de alerta → nenhum núcleo severo (amarelo preservado)", () => {
		const soArea = [cena[0]];
		expect(nucleoSeveroIminente(soArea)).toBe(null);
	});

	test("núcleo severo só em VIGILÂNCIA (82 km) não promove a laranja", () => {
		expect(nucleoSeveroIminente([cena[2]])).toBe(null);
	});

	test("entre dois núcleos iminentes, o extreme manda (mesmo mais longe)", () => {
		const dois = [
			{ ...cena[1], intensity: "heavy" as const, distToTargetKm: 40 },
			cena[1],
		];
		expect(nucleoSeveroIminente(dois)?.intensity).toBe("extreme");
	});

	test("sem entidade severa: lista vazia → null", () => {
		expect(nucleoSeveroIminente([])).toBe(null);
	});
});

describe("os gates antigos seguem valendo (não regride o incidente de 12/08)", () => {
	test("extreme a 40 km sem movimento confiável = ALERTA (fallback segurança)", () => {
		expect(classifyRelevanceZone(40, null, null, "extreme", null)).toBe("alert");
	});

	test("approaching dentro do gate = alerta; ETA maior = vigilância", () => {
		expect(classifyRelevanceZone(74, "approaching", 90, "extreme", 100)).toBe("alert");
		expect(classifyRelevanceZone(74, "approaching", 200, "extreme", 100)).toBe("watch");
	});

	test("além de 250 km é SEMPRE monitor, mesmo aproximando", () => {
		expect(classifyRelevanceZone(300, "approaching", 60, "heavy", 100)).toBe("monitor");
		expect(classifyRelevanceZone(566, "approaching", 120, "heavy", 125)).toBe("monitor");
	});
});
