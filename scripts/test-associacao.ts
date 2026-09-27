/**
 * Associação de núcleos entre frames (incidente ao vivo 27/09/2026).
 *
 * Estado real observado: dois núcleos extreme a 51,8 km e 63,5 km de Ipiranga
 * saíam com o MESMO `fromLat/fromLon` (-25.4401, -51.0103) e um deles com
 * `reversal: true` (rumo invertido 180°). Motivo: o vizinho-mais-próximo era
 * calculado por núcleo novo, SEM exclusividade — dois novos escolhiam o mesmo
 * antigo e o vetor saía inventado. Resultado: veredito "crossing" (sem alerta)
 * com o temporal vindo de fato — o dono leu o mapa certo e o app errou.
 */
import { describe, expect, test } from "bun:test";
import {
	associateMovements,
	formatRainEntityAlert,
	tendenciaIntensidade,
	type FrameAnalysis,
	type RainCell,
} from "../src/radar-analysis.js";

/** Núcleo de teste: só o que a associação usa (posição, dBZ, px). */
function cell(opts: {
	lat: number;
	lon: number;
	dbz: number;
	px?: number;
	cx?: number;
	cy?: number;
}): RainCell {
	return {
		intensity: opts.dbz >= 45 ? "extreme" : opts.dbz >= 37 ? "heavy" : "moderate",
		pixelCount: opts.px ?? 2000,
		maxDbz: opts.dbz,
		meanDbz: opts.dbz - 12,
		centroidX: opts.cx ?? 128,
		centroidY: opts.cy ?? 128,
		lat: opts.lat,
		lon: opts.lon,
	};
}

function frame(time: number, cells: RainCell[]): FrameAnalysis {
	return { time, cells, maxDbz: 55, coverage: 0.2 };
}

// Ponto do frame antigo que, ao vivo, era escolhido por DUAS células novas.
const A = { lat: -25.44, lon: -51.0103 };
// Deslocamentos REALISTAS: 0,10° ≈ 11 km e 0,16° ≈ 17,8 km em 10 min
// (66 e 107 km/h — dentro do filtro de plausibilidade de 150 km/h).
/** ~11 km ao norte — o par mais próximo. */
const NORTE = { lat: -25.34, lon: -51.024 };
/** ~17,8 km ao norte — dentro do raio de associação (80 km), mas mais longe. */
const NORTE_LONGE = { lat: -25.28, lon: -51.04 };

describe("associação de núcleos é EXCLUSIVA (um antigo por núcleo novo)", () => {
	test("dois núcleos novos não podem casar com o mesmo antigo", () => {
		const older = frame(1_000_000, [cell({ ...A, dbz: 52 })]);
		const novoPerto = cell({ ...NORTE, dbz: 53 });
		const novoLonge = cell({ ...NORTE_LONGE, dbz: 50 });
		const newer = frame(1_000_000 + 10 * 60_000, [novoPerto, novoLonge]);

		associateMovements(older, newer);

		const comMovimento = newer.cells.filter((c) => c.trackedMovement);
		expect(comMovimento.length).toBe(1); // o mais próximo; o outro fica sem par
		expect(novoPerto.trackedMovement?.fromLat).toBeCloseTo(A.lat, 6);
		expect(novoLonge.trackedMovement).toBe(null);
	});

	test("não existe fromLat repetido entre núcleos (bug ao vivo)", () => {
		const older = frame(1_000_000, [
			cell({ ...A, dbz: 52 }),
			cell({ lat: -25.7, lon: -51.2, dbz: 48 }),
		]);
		const a = cell({ ...NORTE, dbz: 53 });
		const b = cell({ lat: -25.55, lon: -51.18, dbz: 49 });
		const newer = frame(1_000_000 + 10 * 60_000, [a, b]);

		associateMovements(older, newer);

		const origens = newer.cells
			.map((c) => c.trackedMovement)
			.filter(Boolean)
			.map((m) => `${m!.fromLat},${m!.fromLon}`);
		expect(origens.length).toBe(2);
		expect(new Set(origens).size).toBe(origens.length); // todas distintas
	});

	test("velocidade implausível (>150 km/h) não vira movimento", () => {
		const older = frame(1_000_000, [cell({ ...A, dbz: 52 })]);
		// ~0,6° ao norte em 10 min ≈ 400 km/h
		const rapido = cell({ lat: -24.84, lon: -51.01, dbz: 52 });
		const newer = frame(1_000_000 + 10 * 60_000, [rapido]);
		associateMovements(older, newer);
		expect(rapido.trackedMovement).toBe(null);
	});

	test("sem par dentro de 80 km: sem movimento (não inventa)", () => {
		const older = frame(1_000_000, [cell({ ...A, dbz: 52 })]);
		const distante = cell({ lat: -22.0, lon: -51.0, dbz: 52 });
		const newer = frame(1_000_000 + 10 * 60_000, [distante]);
		associateMovements(older, newer);
		expect(distante.trackedMovement).toBe(null);
	});
});

describe("tendência de intensidade (dissipação no caminho)", () => {
	test("ΔdBZ do par associado vira tendência", () => {
		const older = frame(1_000_000, [cell({ ...A, dbz: 52 })]);
		const enfraquecendo = cell({ ...NORTE, dbz: 46 });
		const intensificando = cell({ lat: -25.5, lon: -51.5, dbz: 58 });
		const newer = frame(1_000_000 + 10 * 60_000, [enfraquecendo, intensificando]);
		associateMovements(older, newer);

		const m1 = enfraquecendo.trackedMovement;
		expect(m1?.dbzAnterior).toBe(52);
		expect(m1?.deltaDbz).toBe(-6);
		expect(m1?.tendencia).toBe("enfraquecendo");
		// o segundo casou com o antigo? não — só um antigo existe (exclusividade)
		expect(intensificando.trackedMovement).toBe(null);
	});

	test("limiares: ±5 dBZ separa mudança de oscilação", () => {
		expect(tendenciaIntensidade(-6)).toBe("enfraquecendo");
		expect(tendenciaIntensidade(-5)).toBe("enfraquecendo");
		expect(tendenciaIntensidade(-4.9)).toBe("estavel");
		expect(tendenciaIntensidade(0)).toBe("estavel");
		expect(tendenciaIntensidade(4.9)).toBe("estavel");
		expect(tendenciaIntensidade(5)).toBe("intensificando");
		expect(tendenciaIntensidade(null)).toBe(null);
		expect(tendenciaIntensidade(undefined)).toBe(null);
		expect(tendenciaIntensidade(Number.NaN)).toBe(null);
	});

	test("texto do card avisa quando o núcleo está dissipando", () => {
		const dissipando = formatRainEntityAlert({
			level: "alert",
			kind: "nucleo",
			intensity: "extreme",
			distKm: 52,
			approach: "approaching",
			etaMin: 62,
			tendencia: "enfraquecendo",
		});
		expect(dissipando).toContain("enfraquecendo no caminho");
		expect(dissipando).toContain("pode dissipar antes de chegar");
		expect(dissipando).toContain("chegada em ~62 min"); // não esconde a chegada

		const firme = formatRainEntityAlert({
			level: "alert",
			kind: "nucleo",
			intensity: "extreme",
			distKm: 52,
			approach: "approaching",
			etaMin: 62,
			tendencia: "estavel",
		});
		expect(firme).not.toContain("dissipar");
		expect(firme).toContain("COPEL"); // cauda normal volta quando não dissipa
	});
});
