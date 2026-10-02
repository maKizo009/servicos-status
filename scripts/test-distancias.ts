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

	test("ignora velocidade em km/h, mas mantém distância em km", () => {
		expect(extrairDistanciasCitadas("movimento a 40 km/h.")).toEqual([]);
		expect(extrairDistanciasCitadas("velocidade 40 km/h, núcleo a 80 km.")).toEqual([
			{ km: 80, cidade: null },
		]);
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

	test("citação mantém distância da entidade quando o rótulo municipal muda na fronteira", () => {
		// Ciclo real: texto ficou com Guarapuava (72 km); no ciclo seguinte,
		// o mesmo núcleo andou e a malha passou a rotulá-lo Prudentópolis (67 km).
		const r = avaliarDistanciasCitadas("Núcleo em Guarapuava a 72 km.", [
			{ km: 67, municipio: "Prudentópolis" },
		]);
		expect(r.ok).toBe(true);
	});

	test("cidade com número que não bate com nenhum centróide nem entidade reprova", () => {
		const r = avaliarDistanciasCitadas("Núcleo em Guarapuava a 150 km.", [
			{ km: 67, municipio: "Prudentópolis" },
		]);
		expect(r.ok).toBe(false);
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
			[202, 270],
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

describe("caso real 30/09/2026 14:40 — 'Santa Isabel do Ivaí a 333 km'", () => {
	// O texto do muse-spark citava a distância da ÁREA (distToTargetKm=333,
	// pareada com Santa Isabel do Ivaí no template) e o extrator antigo casava
	// "Santa Isabel" — OUTRO município, centróide 481 km — rejeitando o
	// boletim correto → heurística em série (falhas=4 no /health).
	const texto =
		"Choveu nas últimas horas em Ipiranga, com 22,6 mm acumulados em 24 horas. Não há núcleo de tempestade por perto no radar, mas há áreas de chuva moderada longe, como a de Ipumirim a 274 km e a de Santa Isabel do Ivaí a 333 km se aproximando.";

	test("extrator resolve o nome MAIS LONGO (Santa Isabel do Ivaí, não Santa Isabel)", () => {
		const dists = extrairDistanciasCitadas(texto);
		expect(dists.length).toBe(2);
		expect(dists[0]?.cidade).toBe("Ipumirim");
		expect(dists[0]?.km).toBe(274);
		expect(dists[1]?.cidade).toBe("Santa Isabel do Ivaí");
		expect(dists[1]?.km).toBe(333);
	});

	test("validação passa com entidades pareadas (mesmo rótulo do prompt)", () => {
		const refs = [
			{ km: 274, municipio: "Ipumirim" },
			{ km: 333, municipio: "Santa Isabel do Ivaí" },
		];
		const r = avaliarDistanciasCitadas(texto, refs);
		expect(r.problemas).toEqual([]);
		expect(r.ok).toBe(true);
	});

	test("alucinação continua reprova: número sem pareamento nem centróide", () => {
		const textoRuim =
			"há áreas de chuva em Ipumirim a 274 km e em Santa Isabel do Ivaí a 999 km.";
		const refs = [
			{ km: 274, municipio: "Ipumirim" },
			{ km: 333, municipio: "Santa Isabel do Ivaí" },
		];
		const r = avaliarDistanciasCitadas(textoRuim, refs);
		expect(r.ok).toBe(false);
		expect(r.problemas.join(" ")).toContain("999 km");
	});

	test("entidade pareada salva texto cujo centróide diverge (métrica do template)", () => {
		// Caso sintético: área na borda de São Mateus do Sul — distToTargetKm=150,
		// centróide 101 km (Δ49 > tol cidade 25). Sem pareamento reprovaria.
		const r = avaliarDistanciasCitadas("chuva em São Mateus do Sul a 150 km.", [
			{ km: 150, municipio: "São Mateus do Sul" },
		]);
		expect(r.ok).toBe(true);
	});
});

describe("caso real 01/10/2026 — cidade DEPOIS do número ('a 327 km em Planaltina do Paraná')", () => {
	// O VLM (nvidia_nim) inverteu a ordem do template: cidade depois da
	// distância. O extrator só olhava ANTES → cidade=null → a citação caía
	// na comparação com núcleos medidos; a chuva em Planaltina era moderada
	// (fora do limiar de threat) e nenhum núcleo ficava a ~327 km → falso
	// alarme distancia_inconsistente. A métrica certa é a da CIDADE
	// (centróide 320 km, Δ7 ≪ tolerância). Radar confirmava chuva real lá.
	const texto =
		"Não há chuva medida em Ipiranga. Pode haver um núcleo de chuva forte a 163 km em Piên, que pode se aproximar se mantiver o curso, e outro a 187 km em Rio Negrinho que se afasta. Há também uma área de chuva moderada a 327 km em Planaltina do Paraná, que pode chegar em cerca de 6 horas. O modelo ECMWF indica 0 % de chance de chuva nas próximas 6 h.";

	test("extrator pareia a cidade que vem DEPOIS do número (preposição locativa)", () => {
		const dists = extrairDistanciasCitadas(texto);
		expect(dists.map((d) => [d.km, d.cidade])).toEqual([
			[163, "Piên"],
			[187, "Rio Negrinho"],
			[327, "Planaltina do Paraná"],
		]);
	});

	test("validação passa pela CIDADE mesmo sem entidade ~327 (chuva moderada fora do limiar de threat)", () => {
		// Refs do ciclo real: nenhuma entidade entre 301-353 km — a citação
		// só se sustenta pela métrica da cidade, que é a correta aqui.
		const refs = [
			{ km: 162.76, municipio: "Piên" },
			{ km: 188.36, municipio: "Rio Negrinho" },
			{ km: 280.93, municipio: "Sete Barras" },
			{ km: 366.16, municipio: "Teodoro Sampaio" },
		];
		const r = avaliarDistanciasCitadas(texto, refs);
		expect(r.problemas).toEqual([]);
		expect(r.ok).toBe(true);
	});

	test("alucinação com cidade DEPOIS do número continua reprova", () => {
		const r = avaliarDistanciasCitadas(
			"chuva forte a 999 km em Planaltina do Paraná.",
			[{ km: 280.93, municipio: "Sete Barras" }],
		);
		expect(r.ok).toBe(false);
		expect(r.problemas.join(" ")).toContain("999 km");
	});

	test("preposição 'de' depois do número NÃO pareia (referência do alvo)", () => {
		// "477 km de Ipiranga" = distância ATÉ o alvo, não chuva em X.
		const dists = extrairDistanciasCitadas(
			"Radar mostra atividade a 477 km de Ipiranga.",
		);
		expect(dists).toEqual([{ km: 477, cidade: null }]);
	});

	test("fim de frase corta a janela: '100 km. Em Cascavel choveu' não pareia", () => {
		const dists = extrairDistanciasCitadas(
			"Chuva a 100 km. Em Cascavel choveu 22 mm.",
		);
		expect(dists).toEqual([{ km: 100, cidade: null }]);
	});
});
