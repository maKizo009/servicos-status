/**
 * Testes das cotas calibradas + regras Mauá/remanso (10/09/2026).
 * Faixas: P90/P98 de 180 dias reais (14/03–10/09/2026) por sentinela.
 */
import { describe, expect, test } from "bun:test";
import {
	avaliarRisco,
	FAIXAS,
	faixaNivel,
	type HidroEstacao,
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
	});
});
