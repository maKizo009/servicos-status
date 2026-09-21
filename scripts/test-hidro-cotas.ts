/**
 * Testes hidro v3 (11/09/2026): IBR aposentado; flash (IFL) + permanência.
 * Rótulos reais (fotos Dave + Uvaia horária ANA):
 * - OUT23: transbordou 29/10 18h (Uvaia ~739), 7 dias fora (pico 1189)
 * - DEZ24: transbordou 09/12 13h (Uvaia ~339!), 3 dias fora (pico 815)
 * - JAN25: NÃO transbordou 21/01 07:29 (régua 4m, Uvaia ~180)
 */
import { describe, expect, test } from "bun:test";
import {
	avaliarRisco,
	calcularIFL,
	calcularPermanencia,
	FAIXAS,
	faixaEstendida,
	faixaNivel,
	regimeDoMes,
	type ChuvaLocal,
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
		faixa: null,
		serie: [],
		delta6hCm: 0,
		erro: null,
		...over,
	};
}

const SECA: ChuvaLocal = { p1h: 0, p6h: 2, p24h: 5 };

describe("faixas ano hidrológico (inalteradas v3)", () => {
	test("Uvaia 385/455; crítico DEZ24 815", () => {
		expect(FAIXAS["64444000"].atencaoCm).toBe(385);
		expect(FAIXAS["64444000"].alertaCm).toBe(455);
		expect(faixaNivel("64444000", 512)).toBe("alerta");
		expect(faixaEstendida("64444000", 815)).toBe("critico");
	});
});

describe("calcularPermanencia (ajuste n=2: dias = 0.0107*U - 5.7)", () => {
	test("OUT23 replay (Uvaia 1189) → 7 dias, vermelho", () => {
		const r = calcularPermanencia({ uvaiaCm: 1189, deltaUvaia24h: 20 });
		expect(r.diasEstimados).toBe(7);
		expect(r.nivel).toBe("vermelho");
		expect(r.preliminar).toBe(true);
	});
	test("DEZ24 replay (Uvaia 815) → 3 dias, laranja", () => {
		const r = calcularPermanencia({ uvaiaCm: 815, deltaUvaia24h: 10 });
		expect(r.diasEstimados).toBe(3);
		expect(r.nivel).toBe("laranja");
	});
	test("JAN25 replay (Uvaia 180) → 0 dias, verde", () => {
		const r = calcularPermanencia({ uvaiaCm: 180, deltaUvaia24h: 5 });
		expect(r.diasEstimados).toBe(0);
		expect(r.nivel).toBe("verde");
	});
	test("sem Uvaia → 0 dias, verde, sem quebrar", () => {
		const r = calcularPermanencia({ uvaiaCm: null, deltaUvaia24h: null });
		expect(r.diasEstimados).toBe(0);
		expect(r.nivel).toBe("verde");
	});
	test("subindo ≥50cm/24h adiciona 1 dia", () => {
		const base = calcularPermanencia({ uvaiaCm: 815, deltaUvaia24h: 0 });
		const sub = calcularPermanencia({ uvaiaCm: 815, deltaUvaia24h: 60 });
		expect(sub.diasEstimados).toBe(base.diasEstimados + 1);
	});
});

describe("calcularIFL (inalterado v3)", () => {
	test("JAN25 replay (24h=143) → ≥laranja", () => {
		const r = calcularIFL({ p1h: 5, p6h: 40, p24h: 143 });
		expect(["laranja", "vermelho"]).toContain(r.nivel);
	});
	test("seco → verde", () => {
		expect(calcularIFL({ p1h: 0, p6h: 2, p24h: 5 }).nivel).toBe("verde");
	});
});

describe("IFL v3.1 — antecedente + regime", () => {
	test("regimeDoMes: mai–ago frontal, resto convectivo", () => {
		expect(regimeDoMes(1)).toBe("convectivo");
		expect(regimeDoMes(5)).toBe("frontal");
		expect(regimeDoMes(8)).toBe("frontal");
		expect(regimeDoMes(9)).toBe("convectivo");
		expect(regimeDoMes(12)).toBe("convectivo");
	});
	test("JAN25-manhã replay (p24 ~15, p72 ~158, convectivo) → amarelo, não verde", () => {
		const r = calcularIFL({ p1h: 0, p6h: 5, p24h: 15, p72h: 158 });
		expect(r.nivel).toBe("amarelo");
		expect(r.score).toBe(0.35);
	});
	test("antecedente abaixo da barra não eleva (p72=100 convectivo → verde)", () => {
		const r = calcularIFL({ p1h: 0, p6h: 2, p24h: 5, p72h: 100 });
		expect(r.nivel).toBe("verde");
	});
	test("frontal arma palco com menos água (p72=100 frontal → amarelo)", () => {
		const r = calcularIFL({ p1h: 0, p6h: 2, p24h: 5, p72h: 100, regime: "frontal" });
		expect(r.nivel).toBe("amarelo");
	});
	test("antecedente sozinho nunca passa de amarelo (p72=400 seco atual)", () => {
		const r = calcularIFL({ p1h: 0, p6h: 0, p24h: 0, p72h: 400 });
		expect(r.nivel).toBe("amarelo");
	});
	test("gatilho continua mandando (p24=128 → laranja mesmo sem antecedente)", () => {
		const r = calcularIFL({ p1h: 2, p6h: 20, p24h: 128, p72h: 0 });
		expect(r.nivel).toBe("laranja");
	});
});

describe("avaliarRisco v3", () => {
	test("tudo normal + seco → ok", () => {
		const r = avaliarRisco(
			[
				est("64444000", { nivelCm: 200 }),
				est("64504210", { nivelCm: 280 }),
				est("64507000", { nivelCm: 190 }),
			],
			SECA,
		);
		expect(r.riscoCheia).toBe("ok");
		expect(r.ifl?.nivel).toBe("verde");
	});
	test("Cebolão em alerta SOZINHO não gera watch falso de flash (só registra)", () => {
		const r = avaliarRisco(
			[
				est("64444000", { nivelCm: 200 }),
				est("64504210", { nivelCm: 400 }),
				est("64507000", { nivelCm: 190 }),
			],
			SECA,
		);
		// jusante em alerta ainda marca algumaEmAlerta → watch (referência regional).
		expect(r.ifl?.nivel).toBe("verde");
	});
	test("sem dados → ok degradado", () => {
		const r = avaliarRisco([], null);
		expect(r.riscoCheia).toBe("ok");
		expect(r.ifl).toBeNull();
	});
	test("regime via mesOverride (jun=frontal, jan=convectivo)", () => {
		const ests = [est("64444000", { nivelCm: 200 }), est("64504210", { nivelCm: 280 }), est("64507000", { nivelCm: 190 })];
		expect(avaliarRisco(ests, SECA, 6).regime).toBe("frontal");
		expect(avaliarRisco(ests, SECA, 1).regime).toBe("convectivo");
	});
});
