/**
 * Testes das cotas calibradas + regras Mauá/remanso (10/09/2026).
 * Faixas: P90/P98 de 180 dias reais (14/03–10/09/2026) por sentinela.
 */
import { describe, expect, test } from "bun:test";
import {
	avaliarRisco,
	calcularIBR,
	FAIXAS,
	faixaEstendida,
	faixaNivel,
	type HidroEstacao,
	NIVEL_CRITICO,
	TETOS_HISTORICOS,
} from "../src/ana-hidro.js";

function est(codigo: string, over: Partial<HidroEstacao> = {}): HidroEstacao {
	return {
		codigo,
		nome: `Estação ${codigo}`,
		rio: "Tibagi",
		municipio: "X",
		papel: "teste",
		nivelCm: 300,
		vazaoM3s: 500,
		chuvaMm: 0,
		dataHora: "2026-09-10 10:00:00",
		faixa: null,
		serie: [],
		delta6hCm: 0,
		erro: null,
		...over,
	};
}

describe("faixaNivel (P90/P98 calibrados)", () => {
	test("Cebolão 362 = atenção (entre 346 e 369)", () => {
		expect(FAIXAS["64504210"].atencaoCm).toBe(346);
		expect(FAIXAS["64504210"].alertaCm).toBe(369);
		expect(faixaNivel("64504210", 362)).toBe("atencao");
		expect(faixaNivel("64504210", 370)).toBe("alerta");
		expect(faixaNivel("64504210", 300)).toBe("normal");
		expect(faixaNivel("64504210", null)).toBeNull();
		expect(faixaNivel("00000000", 500)).toBeNull();
	});
});

describe("avaliarRisco", () => {
	test("tudo normal + sem chuva → ok, sem drama", () => {
		const r = avaliarRisco(
			[
				est("64491000", { nivelCm: 290 }),
				est("64504210", { nivelCm: 300 }),
				est("64507000", { nivelCm: 200 }),
			],
			2,
		);
		expect(r.riscoCheia).toBe("ok");
		expect(r.resumoRisco).toContain("sem tendência de cheia");
	});
	test("Cebolão em atenção + chuva em Ipiranga → REMANSO", () => {
		const r = avaliarRisco(
			[
				est("64491000", { nivelCm: 290 }),
				est("64504210", { nivelCm: 360 }),
				est("64507000", { nivelCm: 200 }),
			],
			12,
		);
		expect(r.riscoCheia).toBe("watch");
		expect(r.resumoRisco).toMatch(/remanso/i);
		expect(r.resumoRisco).toMatch(/Bitumirim/);
	});
	test("mesmo Tibagi cheio SEM chuva local → sem remanso", () => {
		const r = avaliarRisco(
			[
				est("64491000", { nivelCm: 290 }),
				est("64504210", { nivelCm: 360 }),
				est("64507000", { nivelCm: 200 }),
			],
			2,
		);
		expect(r.resumoRisco).not.toMatch(/remanso/i);
	});
	test("Antas com vazão ≥P98 sem chuva → DESCARGA Mauá", () => {
		const r = avaliarRisco(
			[
				est("64491000", { nivelCm: 290, vazaoM3s: 900, chuvaMm: 1 }),
				est("64504210", { nivelCm: 300 }),
				est("64507000", { nivelCm: 200 }),
			],
			2,
		);
		expect(r.riscoCheia).toBe("watch");
		expect(r.resumoRisco).toMatch(/Mauá liberando/i);
	});
	test("vazão alta COM chuva forte na sentinela → é chuva, não descarga", () => {
		const r = avaliarRisco(
			[
				est("64491000", { nivelCm: 290, vazaoM3s: 900, chuvaMm: 30 }),
				est("64504210", { nivelCm: 300 }),
				est("64507000", { nivelCm: 200 }),
			],
			2,
		);
		expect(r.resumoRisco).not.toMatch(/Mauá liberando/i);
	});
	test("sentinela em alerta (P98) → watch mesmo sem chuva", () => {
		const r = avaliarRisco(
			[
				est("64491000", { nivelCm: 290 }),
				est("64504210", { nivelCm: 300 }),
				est("64507000", { nivelCm: 320 }),
			],
			0,
		);
		expect(r.riscoCheia).toBe("watch");
	});
	test("sem dados → ok degradado, nunca alerta", () => {
		const r = avaliarRisco([], null);
		expect(r.riscoCheia).toBe("ok");
		expect(r.ibr).toBeNull();
	});
});

describe("IBR (Índice de Bloqueio por Remanso)", () => {
	test("tudo calmo → verde, score 0", () => {
		const r = calcularIBR({
			nAntas: 290,
			deltaAntas6h: 0,
			vazaoAntas: 350,
			chuvaAntas: 0,
			nCebolao: 300,
			chuvaIpiranga6h: 2,
		});
		expect(r.nivel).toBe("verde");
		expect(r.score).toBe(0);
	});
	test("só chuva local forte, Tibagi calmo → IBR verde (flash é outra perna)", () => {
		const r = calcularIBR({
			nAntas: 290,
			deltaAntas6h: 0,
			vazaoAntas: 350,
			chuvaAntas: 0,
			nCebolao: 300,
			chuvaIpiranga6h: 30,
		});
		expect(r.score).toBe(0.2);
		expect(r.nivel).toBe("verde");
	});
	test("JAN25 replay (flash: 143mm/dia, Tibagi calmo) → IBR baixo (doutrina 2 pernas)", () => {
		const t = TETOS_HISTORICOS.jan25;
		const r = calcularIBR({
			nAntas: t.antasCm,
			deltaAntas6h: 5,
			vazaoAntas: 550,
			chuvaAntas: 0,
			nCebolao: t.cebolaoCm,
			chuvaIpiranga6h: 40,
		});
		expect(r.score).toBeLessThan(0.5);
	});
	test("DEZ24 replay (622/391 + chuva) → vermelho", () => {
		const t = TETOS_HISTORICOS.dez24;
		const r = calcularIBR({
			nAntas: t.antasCm,
			deltaAntas6h: 40,
			vazaoAntas: 1366,
			chuvaAntas: 2,
			nCebolao: t.cebolaoCm,
			chuvaIpiranga6h: 30,
		});
		expect(r.nivel).toBe("vermelho");
	});
	test("OUT23 replay (903/517 + chuva) → vermelho", () => {
		const t = TETOS_HISTORICOS.out23;
		const r = calcularIBR({
			nAntas: t.antasCm,
			deltaAntas6h: 50,
			vazaoAntas: 2683,
			chuvaAntas: 5,
			nCebolao: t.cebolaoCm,
			chuvaIpiranga6h: 30,
		});
		expect(r.nivel).toBe("vermelho");
	});
	test("hoje (10/09: 501/366 + 24mm) → laranja ou vermelho, nunca verde", () => {
		const r = calcularIBR({
			nAntas: 501,
			deltaAntas6h: 42,
			vazaoAntas: 922,
			chuvaAntas: 3.6,
			nCebolao: 366,
			chuvaIpiranga6h: 24,
		});
		expect(["laranja", "vermelho"]).toContain(r.nivel);
	});
});

describe("faixaEstendida e NIVEL_CRITICO", () => {
	test("DEZ24 = crítico; OUT23 = crítico; hoje abaixo do crítico", () => {
		expect(NIVEL_CRITICO["64504210"]).toBe(391);
		expect(faixaEstendida("64504210", 391)).toBe("critico");
		expect(faixaEstendida("64504210", 517)).toBe("critico");
		expect(faixaEstendida("64504210", 366)).toBe("atencao");
		expect(faixaEstendida("64504210", null)).toBeNull();
	});
});
