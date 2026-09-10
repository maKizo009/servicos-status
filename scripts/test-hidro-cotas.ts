/**
 * Testes hidro v2 (11/09/2026): física corrigida (foz a montante de Mauá).
 * - Faixas P90/P98 do ANO hidrológico (365 dias).
 * - Sentinelas: Uvaia (montante) / Cebolão (foz) / Jataizinho (escoamento).
 * - IBR (remanso, montante) + IFL (flash, 100% local).
 * - Replays: OUT23/DEZ24/JAN25/hoje.
 */
import { describe, expect, test } from "bun:test";
import {
	avaliarRisco,
	type ChuvaLocal,
	calcularIBR,
	calcularIFL,
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

const SECA: ChuvaLocal = { p1h: 0, p6h: 2, p24h: 5 };

describe("faixas ano hidrológico", () => {
	test("Uvaia 385/455, Cebolão 337/360", () => {
		expect(FAIXAS["64444000"].atencaoCm).toBe(385);
		expect(FAIXAS["64444000"].alertaCm).toBe(455);
		expect(FAIXAS["64504210"].atencaoCm).toBe(337);
		expect(FAIXAS["64504210"].alertaCm).toBe(360);
		expect(faixaNivel("64444000", 512)).toBe("alerta");
		expect(faixaNivel("64504210", 300)).toBe("normal");
		expect(faixaEstendida("64504210", 391)).toBe("critico");
		expect(NIVEL_CRITICO["64444000"]).toBe(815);
	});
	test("tetos têm Uvaia + Bitumirim 8 m (OUT23)", () => {
		expect(TETOS_HISTORICOS.out23.uvaiaCm).toBe(1189);
		expect(TETOS_HISTORICOS.out23.bitumirimM).toBe(8);
		expect(TETOS_HISTORICOS.dez24.uvaiaCm).toBe(815);
	});
});

describe("calcularIBR v2 (montante)", () => {
	test("tudo calmo → verde 0", () => {
		const r = calcularIBR({
			nUvaia: 200,
			deltaUvaia6h: 0,
			nCebolao: 280,
			chuvaIpiranga6h: 2,
		});
		expect(r.nivel).toBe("verde");
		expect(r.score).toBe(0);
	});
	test("Uvaia em alerta sozinha → laranja (0.4+chuva? não: 0.4 = amarelo)", () => {
		const r = calcularIBR({
			nUvaia: 500,
			deltaUvaia6h: 5,
			nCebolao: 280,
			chuvaIpiranga6h: 2,
		});
		expect(r.score).toBe(0.4);
		expect(r.nivel).toBe("amarelo");
	});
	test("DEZ24 replay (815/391+chuva) → vermelho", () => {
		const r = calcularIBR({
			nUvaia: 815,
			deltaUvaia6h: 40,
			nCebolao: 391,
			chuvaIpiranga6h: 30,
		});
		expect(r.nivel).toBe("vermelho");
	});
	test("OUT23 replay (1189/517+chuva) → vermelho", () => {
		const r = calcularIBR({
			nUvaia: 1189,
			deltaUvaia6h: 50,
			nCebolao: 517,
			chuvaIpiranga6h: 30,
		});
		expect(r.nivel).toBe("vermelho");
	});
	test("JAN25 replay (Cebolão 325, chuva 40) → verde (sem remanso)", () => {
		const r = calcularIBR({
			nUvaia: null,
			deltaUvaia6h: null,
			nCebolao: 325,
			chuvaIpiranga6h: 40,
		});
		expect(r.score).toBeLessThan(0.5);
	});
	test("hoje (Uvaia 512/Cebolão 370/chuva 24) → vermelho honesto (alto Tibagi)", () => {
		const r = calcularIBR({
			nUvaia: 512,
			deltaUvaia6h: 10,
			nCebolao: 370,
			chuvaIpiranga6h: 24,
		});
		expect(r.nivel).toBe("vermelho");
	});
});

describe("calcularIFL (flash local)", () => {
	test("seco → verde 0", () => {
		const r = calcularIFL({ p1h: 0, p6h: 2, p24h: 5 });
		expect(r.nivel).toBe("verde");
	});
	test("JAN25 replay (24h=143) → laranja pelo piso", () => {
		const r = calcularIFL({ p1h: 5, p6h: 40, p24h: 143 });
		expect(r.score).toBeGreaterThanOrEqual(0.75);
		expect(["laranja", "vermelho"]).toContain(r.nivel);
	});
	test("curto-circuito 1h≥40 → vermelho 1.0", () => {
		const r = calcularIFL({ p1h: 45, p6h: 50, p24h: 60 });
		expect(r.score).toBe(1.0);
		expect(r.nivel).toBe("vermelho");
	});
	test("chuva moderada → proporcional, sem salto", () => {
		const r = calcularIFL({ p1h: 10, p6h: 20, p24h: 30 });
		expect(r.score).toBeLessThan(0.5);
	});
});

describe("avaliarRisco v2", () => {
	test("tudo normal + seco → ok, IBR verde, IFL verde", () => {
		const r = avaliarRisco(
			[
				est("64444000", { nivelCm: 200 }),
				est("64504210", { nivelCm: 280 }),
				est("64507000", { nivelCm: 190 }),
			],
			SECA,
		);
		expect(r.riscoCheia).toBe("ok");
		expect(r.ibr?.nivel).toBe("verde");
		expect(r.ifl?.nivel).toBe("verde");
	});
	test("IFL laranja sozinho → watch (flash sem Tibagi)", () => {
		const r = avaliarRisco(
			[
				est("64444000", { nivelCm: 200 }),
				est("64504210", { nivelCm: 280 }),
				est("64507000", { nivelCm: 190 }),
			],
			{ p1h: 5, p6h: 40, p24h: 143 },
		);
		expect(r.riscoCheia).toBe("watch");
		expect(r.ifl?.nivel).not.toBe("verde");
		expect(r.resumoRisco).toMatch(/flash local IFL/);
	});
	test("sem dados → ok degradado, IBR/IFL nulos", () => {
		const r = avaliarRisco([], null);
		expect(r.riscoCheia).toBe("ok");
		expect(r.ibr).toBeNull();
		expect(r.ifl).toBeNull();
	});
});
