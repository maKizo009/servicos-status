/**
 * Testes da validação de distâncias citadas (causa raiz 30/09/2026).
 *
 * O watchdog reprovaria um boletim CORRETO: o texto citava a distância da
 * CIDADE ("Guaporema a 294 km" — 297 km até o centróide) e a checagem
 * comparava com `distToTargetKm` do NÚCLEO (270 km). A regra correta aceita
 * as DUAS métricas, cada uma na sua referência.
 *
 * Rode com: bun test ./scripts/test-distancias.ts
 */
import { describe, expect, test } from "bun:test";
import {
	avaliarDistanciasCitadas,
	distanciaMunicipioKm,
	extrairDistanciasCitadas,
} from "../src/validacao-distancias.js";

describe("distanciaMunicipioKm (malha IBGE)", () => {
	test("Guaporema fica ~297 km de Ipiranga (caso real do falso alarme)", () => {
		const d = distanciaMunicipioKm("Guaporema");
		expect(d).not.toBeNull();
		expect(Math.abs((d ?? 0) - 297)).toBeLessThan(10);
	});

	test("município inexistente → null (nunca NaN)", () => {
		expect(distanciaMunicipioKm("Cidade Inexistente XYZ")).toBeNull();
	});
});

describe("extrairDistanciasCitadas", () => {
	test("pega '<cidade> a N km' e ignora mm/dBZ/h", () => {
		const texto =
			"Choveu 22,6 mm em 24h. Áreas de chuva moderada em Mangueirinha a 210 km e em Guaporema a 294 km se aproximam. Núcleo de 38 dBZ em 6 h.";
		const dists = extrairDistanciasCitadas(texto);
		expect(dists.length).toBe(2);
		expect(dists[0]?.cidade).toBe("Mangueirinha");
		expect(dists[0]?.km).toBe(210);
		expect(dists[1]?.cidade).toBe("Guaporema");
		expect(dists[1]?.km).toBe(294);
	});

	test("distância sem cidade vem com cidade=null", () => {
		const dists = extrairDistanciasCitadas(
			"Radar mostra atividade a 477 km de Ipiranga.",
		);
		expect(dists.length).toBe(1);
		expect(dists[0]?.cidade).toBeNull();
		expect(dists[0]?.km).toBe(477);
	});
});

describe("avaliarDistanciasCitadas", () => {
	// Caso REAL do alerta de 30/09/2026 (boletim correto, watchdog errado):
	// texto citava cidades (210/294 km) enquanto os núcleos medidos estavam a
	// 202/270/319 km — o núcleo não fica no centro da cidade.
	test("caso real: cidade citada valida pela distância da CIDADE, não do núcleo", () => {
		const texto =
			"Áreas de chuva moderada em Mangueirinha a 210 km e em Guaporema a 294 km se aproximam.";
		const r = avaliarDistanciasCitadas(texto, [202, 270, 319, 366, 477]);
		expect(r.problemas).toEqual([]);
		expect(r.ok).toBe(true);
	});

	test("alucinação de verdade: número que não bate com nada reprova", () => {
		const texto = "Núcleo violento se aproxima a 500 km de Ipiranga.";
		const r = avaliarDistanciasCitadas(texto, [202, 270]);
		expect(r.ok).toBe(false);
		expect(r.problemas.join(" ")).toContain("500 km");
	});

	test("distância medida (sem cidade) bate com o núcleo e passa", () => {
		const r = avaliarDistanciasCitadas(
			"Atividade de radar detectada a ~477 km de Ipiranga.",
			[477, 319],
		);
		expect(r.ok).toBe(true);
	});

	test("cidade citada com distância de cidade real passa mesmo sem threats", () => {
		const r = avaliarDistanciasCitadas("Chuva em Guaporema a 297 km.", []);
		expect(r.ok).toBe(true);
	});

	test("cidade citada com distância inventada reprova (mesmo com threats variados)", () => {
		const r = avaliarDistanciasCitadas(
			"Chuva em Guaporema a 100 km.",
			[100, 270],
		);
		expect(r.ok).toBe(false);
		expect(r.problemas.join(" ")).toContain("Guaporema");
	});

	test("tolerância: cidade aceita ±12% (o núcleo não fica no centro)", () => {
		// Mangueirinha: centróide 198 km → 210 citados (Δ12 = 6%) passa;
		// 250 citados (Δ52) reprova.
		expect(
			avaliarDistanciasCitadas("em Mangueirinha a 210 km.", [500]).ok,
		).toBe(true);
		expect(
			avaliarDistanciasCitadas("em Mangueirinha a 250 km.", [500]).ok,
		).toBe(false);
	});
});
