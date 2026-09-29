/**
 * Livro da dissipação: agrupamento em episódios, desfecho e resumo.
 *
 * Fixtures com NÚMEROS REAIS, não inventados: o episódio 1 é a sequência noturna
 * de 27–28/09/2026 observada ao vivo (58 dBZ a 47 km → 38 dBZ a 43 km, −20 dBZ
 * num frame → 38 dBZ a 20,9 km re-intensificando), com a estação medindo 0 mm
 * o tempo todo. Os demais casos são os desfechos que o livro precisa distinguir.
 */
import { describe, expect, test } from "bun:test";
import {
	type AmostraNucleo,
	agruparEpisodios,
	CHEGADA_KM,
	desfechoDoEpisodio,
	fecharEpisodio,
	formatarRelatorioTexto,
	JANELA_ABERTA_MIN,
	marcarEpisodiosAbertos,
	resumoDissipacao,
} from "../src/dissipacao.js";

const T0 = 1_790_550_000_000; // base estável para os testes
const min = (n: number) => n * 60_000;

function a(over: Partial<AmostraNucleo> = {}): AmostraNucleo {
	return {
		medidoEm: T0,
		lat: -25.3,
		lon: -51.0,
		distKm: 45,
		maxDbz: 58,
		intensity: "extreme",
		kind: "nucleo",
		isolado: true,
		framesVivo: 3,
		deltaDbz: 0,
		tendencia: "estavel",
		approach: "approaching",
		etaMin: 90,
		zona: "alert",
		nivel: "laranja",
		chuva1hMm: 0,
		chuva6hMm: 0,
		...over,
	};
}

describe("agrupamento em episódios", () => {
	test("núcleo que anda por 3 ciclos = UM episódio", () => {
		const eps = agruparEpisodios([
			a({ medidoEm: T0, distKm: 47.2, maxDbz: 58, lat: -25.45, lon: -51.02 }),
			a({
				medidoEm: T0 + min(10),
				distKm: 42.9,
				maxDbz: 38,
				deltaDbz: -20,
				tendencia: "enfraquecendo",
				lat: -25.41,
				lon: -50.99,
			}),
			a({
				medidoEm: T0 + min(20),
				distKm: 20.9,
				maxDbz: 43,
				deltaDbz: 5,
				tendencia: "intensificando",
				lat: -25.29,
				lon: -50.9,
			}),
		]);
		expect(eps.length).toBe(1);
		expect(eps[0]?.amostras).toBe(3);
		expect(eps[0]?.distMinKm).toBe(20.9);
		expect(eps[0]?.dbzInicial).toBe(58);
		expect(eps[0]?.dbzFinal).toBe(43);
		expect(eps[0]?.deltaDbz).toBe(-15);
		expect(eps[0]?.duracaoMin).toBe(20);
	});

	test("dois núcleos distintos no mesmo ciclo = dois episódios (exclusividade)", () => {
		// Caso real: dois núcleos isolados a ~20 km de Ipiranga, 30+ km entre si.
		const eps = agruparEpisodios([
			a({ medidoEm: T0, lat: -25.29, lon: -50.9, distKm: 20.9 }),
			a({ medidoEm: T0, lat: -25.6, lon: -51.2, distKm: 38.2, maxDbz: 38 }),
			a({ medidoEm: T0 + min(10), lat: -25.28, lon: -50.89, distKm: 19.5 }),
			a({ medidoEm: T0 + min(10), lat: -25.59, lon: -51.19, distKm: 37.0, maxDbz: 38 }),
		]);
		expect(eps.length).toBe(2);
		expect(eps.every((e) => e.amostras === 2)).toBe(true);
	});

	test("buraco maior que a janela vira OUTRO episódio (núcleo sumiu e voltou)", () => {
		const eps = agruparEpisodios([
			a({ medidoEm: T0 }),
			a({ medidoEm: T0 + min(45) }), // 45 min depois: > JANELA_EPISODIO_MIN
		]);
		expect(eps.length).toBe(2);
	});

	test("mesmo ciclo com dois núcleos PRÓXIMOS não se misturam (greedy exclusivo)", () => {
		const eps = agruparEpisodios([
			a({ medidoEm: T0, lat: -25.30, lon: -51.00, distKm: 30 }),
			a({ medidoEm: T0 + min(10), lat: -25.31, lon: -51.01, distKm: 29 }),
			a({ medidoEm: T0 + min(10), lat: -25.32, lon: -51.02, distKm: 28, maxDbz: 40 }),
		]);
		// 2 amostras no ciclo 2 para 1 no ciclo 1: um núcleo continua, o outro nasce.
		expect(eps.length).toBe(2);
		expect(eps.map((e) => e.amostras).sort()).toEqual([1, 2]);
	});
});

describe("desfecho do episódio", () => {
	test("chegou (distMin ≤ 25 km) com chuva medida = molhou", () => {
		const ep = fecharEpisodio([
			a({ medidoEm: T0, distKm: 47 }),
			a({ medidoEm: T0 + min(10), distKm: 12, chuva1hMm: 3.4, chuva6hMm: 8 }),
		]);
		expect(ep.distMinKm).toBeLessThanOrEqual(CHEGADA_KM);
		expect(ep.desfecho).toBe("chegou_e_molhou");
		expect(ep.chuvaNoEpisodioMm).toBe(8);
	});

	test("chegou sem molhar = chegou_seco (o caso 'virga')", () => {
		const ep = fecharEpisodio([
			a({ medidoEm: T0, distKm: 30, maxDbz: 53 }),
			a({ medidoEm: T0 + min(10), distKm: 8, maxDbz: 48, chuva1hMm: 0, chuva6hMm: 0 }),
		]);
		expect(ep.desfecho).toBe("chegou_seco");
	});

	test("não chegou e perdeu ≥5 dBZ = dissipou no caminho", () => {
		const ep = fecharEpisodio([
			a({ medidoEm: T0, distKm: 80, maxDbz: 53 }),
			a({
				medidoEm: T0 + min(10),
				distKm: 62,
				maxDbz: 44,
				deltaDbz: -9,
				tendencia: "enfraquecendo",
			}),
		]);
		expect(ep.desfecho).toBe("dissipou_no_caminho");
	});

	test("virou área moderada (≤37 dBZ) = dissipou, mesmo com queda pequena", () => {
		const ep = fecharEpisodio([
			a({ medidoEm: T0, distKm: 90, maxDbz: 40, intensity: "heavy" }),
			a({ medidoEm: T0 + min(10), distKm: 80, maxDbz: 36, intensity: "moderate" }),
		]);
		expect(ep.desfecho).toBe("dissipou_no_caminho");
	});

	test("não chegou e continuou forte = sumiu antes de chegar (não inventa causa)", () => {
		const ep = fecharEpisodio([
			a({ medidoEm: T0, distKm: 140, maxDbz: 58 }),
			a({ medidoEm: T0 + min(10), distKm: 118, maxDbz: 58 }),
		]);
		expect(ep.desfecho).toBe("sumiu_antes_de_chegar");
	});

	test("regra de desfecho é estável: desfechoDoEpisodio concorda com o fechamento", () => {
		const ep = fecharEpisodio([a({ medidoEm: T0, distKm: 10, chuva6hMm: 0.5 })]);
		expect(desfechoDoEpisodio(ep)).toBe(ep.desfecho);
	});
});

describe("resumo do livro", () => {
	test("conta os desfechos e as porcentagens", () => {
		const eps = [
			fecharEpisodio([a({ medidoEm: T0, distKm: 12, chuva6hMm: 5 })]), // molhou
			fecharEpisodio([a({ medidoEm: T0, distKm: 9 })]), // chegou seco
			fecharEpisodio([
				a({ medidoEm: T0, distKm: 90, maxDbz: 55 }),
				a({
					medidoEm: T0 + min(10),
					distKm: 70,
					maxDbz: 45,
					deltaDbz: -10,
					tendencia: "enfraquecendo",
				}),
			]), // dissipou
			fecharEpisodio([a({ medidoEm: T0, distKm: 150 })]), // sumiu
		];
		const r = resumoDissipacao(eps);
		expect(r.episodios).toBe(4);
		expect(r.chegaram).toBe(2);
		expect(r.chegouEMolhou).toBe(1);
		expect(r.chegouSeco).toBe(1);
		expect(r.dissipouNoCaminho).toBe(1);
		expect(r.sumiuAntes).toBe(1);
		expect(r.pctChegouMolhando).toBe(50);
		expect(r.pctEnfraqueceu).toBe(25);
		expect(r.deltaDbzMedio).toBe(-2.5);
	});

	test("livro vazio não explode (nenhuma divisão por zero)", () => {
		const r = resumoDissipacao([]);
		expect(r.episodios).toBe(0);
		expect(r.pctChegouMolhando).toBe(0);
		expect(r.pctEnfraqueceu).toBe(0);
		expect(r.deltaDbzMedio).toBe(0);
	});

	test("conta episódios isolados só quando há o dado", () => {
		const comDado = fecharEpisodio([a({ medidoEm: T0, isolado: true })]);
		const semDado = fecharEpisodio([
			a({ medidoEm: T0 + min(30), isolado: null, lat: -25.9, lon: -51.5 }),
		]);
		const r = resumoDissipacao([comDado, semDado]);
		expect(r.isoladosComDado).toBe(1);
		expect(r.isolados).toBe(1);
	});
});

describe("texto do relatório (formatador único)", () => {
	test("livro vazio avisa que ainda não há episódios", () => {
		const t = formatarRelatorioTexto([], 14);
		expect(t).toContain("Livro da dissipação");
		expect(t).toContain("Ainda sem episódios");
	});

	test("com episódios conta os desfechos e declara as limitações", () => {
		const eps = [
			fecharEpisodio([a({ medidoEm: T0, distKm: 12, chuva6hMm: 4 })]),
			fecharEpisodio([a({ medidoEm: T0, distKm: 9 })]),
			fecharEpisodio([
				a({ medidoEm: T0, distKm: 120, maxDbz: 58 }),
				a({
					medidoEm: T0 + min(10),
					distKm: 100,
					maxDbz: 58,
				}),
			]),
		];
		const t = formatarRelatorioTexto(eps, 7);
		expect(t).toContain("chegou e molhou a estação : 1");
		expect(t).toContain("chegou seco (eco em altura): 1");
		expect(t).toContain("sumiu antes de chegar    : 1");
		expect(t).toContain("dos que chegaram, molharam: 50%");
		// limitação tem que estar no TEXTO (não só no código)
		expect(t).toContain("não distingue dissipação real");
		expect(t).toContain("sem atribuição célula→estação");
		expect(t).toContain("💧");
	});
});

/**
 * Correções de 29/09/2026 — o balde "sumiu antes de chegar" estava inflado.
 *
 * Revisão do dono depois do falso laranja: dos 86 episódios, 73 apareciam como
 * "sumiu antes de chegar", mas só 14% tinham queda ≥5 dBZ e o ΔdBZ médio era
 * −1 dBZ. Duas causas mecânicas: episódio de 1 ciclo (a maioria) entrava como
 * desfecho, e núcleo que regredia para área de chuva saía do livro sem desfecho
 * (o relatório só alimentava amostras de núcleo).
 */
describe("episódios em aberto (observação incompleta não é desfecho)", () => {
	test("núcleo visto num ciclo e ainda recente fica EM ABERTO (caso real 29/09)", () => {
		// O núcleo de 38 dBZ a 64 km que disparou o falso laranja: 1 ciclo só.
		const eps = agruparEpisodios(
			[a({ medidoEm: T0, distKm: 64, maxDbz: 38, intensity: "heavy", tendencia: "enfraquecendo" })],
			{ agoraMs: T0 + min(5) },
		);
		expect(eps.length).toBe(1);
		expect(eps[0]?.desfecho).toBe("em_aberto");
		expect(eps[0]?.emAberto).toBe(true);
	});

	test("o MESMO episódio vira desfecho depois da janela de observação", () => {
		const eps = agruparEpisodios(
			[a({ medidoEm: T0, distKm: 64, maxDbz: 38, intensity: "heavy" })],
			{ agoraMs: T0 + min(JANELA_ABERTA_MIN + 10) },
		);
		expect(eps[0]?.desfecho).toBe("sumiu_antes_de_chegar");
		expect(eps[0]?.emAberto).toBeFalsy();
	});

	test("sem `agoraMs` nada fica em aberto (compatível com o uso antigo)", () => {
		const eps = agruparEpisodios([a({ medidoEm: T0, distKm: 64, maxDbz: 38 })]);
		expect(eps[0]?.desfecho).not.toBe("em_aberto");
	});

	test("em aberto fica FORA das estatísticas do resumo", () => {
		const aberto = marcarEpisodiosAbertos(
			[fecharEpisodio([a({ medidoEm: T0, distKm: 150, maxDbz: 58 })])],
			T0 + min(5),
		);
		const fechado = fecharEpisodio([
			a({ medidoEm: T0 - min(600), distKm: 150, maxDbz: 58 }),
			a({ medidoEm: T0 - min(590), distKm: 130, maxDbz: 58 }),
		]);
		const r = resumoDissipacao([...aberto, fechado]);
		expect(r.episodios).toBe(2);
		expect(r.emAberto).toBe(1);
		expect(r.concluidos).toBe(1);
		expect(r.sumiuAntes).toBe(1); // só o concluído conta
	});

	test("marcar é idempotente (reaplicar não muda o desfecho)", () => {
		const uma = marcarEpisodiosAbertos(
			[fecharEpisodio([a({ medidoEm: T0, distKm: 64 })])],
			T0 + min(5),
		);
		const duas = marcarEpisodiosAbertos(uma, T0 + min(6));
		expect(duas[0]?.desfecho).toBe("em_aberto");
		expect(duas[0]?.emAberto).toBe(true);
	});

	test("o texto separa concluídos dos em aberto e explica", () => {
		const eps = marcarEpisodiosAbertos(
			[
				fecharEpisodio([a({ medidoEm: T0 - min(600), distKm: 150 })]),
				fecharEpisodio([a({ medidoEm: T0, distKm: 64 })]),
			],
			T0 + min(5),
		);
		const t = formatarRelatorioTexto(eps, 14);
		expect(t).toContain("concluídos: 1 | em aberto: 1");
		expect(t).toContain("EM ABERTO (⏳)");
	});
});

describe("núcleo que regride para área de chuva = dissipação medida", () => {
	test("amostra de ÁREA continua o episódio do núcleo e fecha como dissipou", () => {
		const eps = agruparEpisodios([
			// ciclo 1: núcleo forte a 60 km
			a({ medidoEm: T0, distKm: 60, maxDbz: 43, intensity: "heavy" }),
			// ciclo 2: o mesmo sistema agora é ÁREA moderada (33 dBZ) — o caso real
			// das 15:50 de 29/09/2026, quando o app rebaixou para amarelo.
			a({
				medidoEm: T0 + min(10),
				distKm: 58,
				maxDbz: 33,
				intensity: "moderate",
				kind: "area",
			}),
		]);
		expect(eps.length).toBe(1);
		expect(eps[0]?.amostras).toBe(2);
		expect(eps[0]?.kindFinal).toBe("area");
		expect(eps[0]?.desfecho).toBe("dissipou_no_caminho");
	});

	test("área de chuva que NUNCA foi núcleo não abre episódio", () => {
		expect(
			agruparEpisodios([
				a({ medidoEm: T0, kind: "area", intensity: "moderate", maxDbz: 30 }),
				a({
					medidoEm: T0 + min(10),
					kind: "area",
					intensity: "moderate",
					maxDbz: 28,
				}),
			]),
		).toEqual([]);
	});

	test("o relatório marca o episódio que regrediu a área", () => {
		const eps = agruparEpisodios([
			a({ medidoEm: T0, distKm: 60, maxDbz: 43, intensity: "heavy" }),
			a({
				medidoEm: T0 + min(10),
				distKm: 58,
				maxDbz: 33,
				intensity: "moderate",
				kind: "area",
			}),
		]);
		expect(formatarRelatorioTexto(eps, 14)).toContain("[regrediu a área de chuva]");
	});
});
