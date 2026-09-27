/**
 * Recessão do nível (27/09/2026) — o alerta CAI quando o rio está DIMINUINDO.
 *
 * Pedido do dono: o card mostrava "Rio Uvaia em alerta" com o nível CAINDO e
 * "risco de transbordar: baixo". Causa: o `watch` ligava com qualquer sentinela
 * na faixa P98 (`algumaEmAlerta`) e a ÚNICA saída era o nível voltar abaixo da
 * faixa — com o Uvaia em 6,47 m caindo ~2 cm/h isso levaria dias.
 *
 * Os arrays abaixo são SÉRIES REAIS da telemetria ANA (DadosHidrometeorologicos),
 * já na ordem que o backend usa: MAIS NOVO PRIMEIRO, com buracos de sensor como
 * `null` (a janela é de 24 slots, como em `fetchEstacao`).
 */
import { describe, expect, test } from "bun:test";
import {
	avaliarRecessao,
	avaliarRisco,
	faixaComRecessao,
	RECESSAO_LIMIARES,
	sentinelaDisparaAlerta,
	type ChuvaLocal,
	type HidroEstacao,
	type HidroSeriePonto,
} from "../src/ana-hidro.js";

// SET26 2026-09-21 13:00:00 — 812.5 cm (faixa alerta) com recessão confirmada.
// MAIS NOVO PRIMEIRO, como o backend recebe de `fetchEstacao`.
const SERIE_SET26_ALERTA_RECESSO: (number | null)[] = [
	812.5, 815.3, 817.0, 818.8, 820.2, 820.9,
	822.1, 822.5, 823.6, 824.1, 826.8, 828.6,
	830.8, 832.5, 834.2, 835.4, 836.7, 837.6,
	838.4, 839.5, 840.1, 841.0, 842.3, 844.1,
];

// OUT23 pico 1189 cm (03/11/2023 06h) — 24 h ATÉ o pico: SUBIDA (mais novo primeiro)
const SERIE_OUT23_SUBINDO: (number | null)[] = [
	1189.3, 1188.9, 1188.9, 1189.1, 1189.0, 1189.1,
	1188.6, 1189.0, 1188.1, 1188.1, 1187.8, 1187.7,
	1187.2, 1187.3, 1186.8, 1186.9, 1186.3, 1186.3,
	1186.2, 1185.9, 1184.6, 1184.9, 1184.9, 1184.7,
];

// OUT23 — 24 slots DESDE o pico, com SEGUNDO PICO no meio da janela
// (em tempo: 1189 → 1108 → volta a 1172). Não pode confirmar recessão.
const SERIE_OUT23_DESCENDO: (number | null)[] = [
	null, null, null, null, null, null,
	null, null, null, 1172.6, 1172.1, 1171.5,
	1170.2, 1169.9, 1168.6, 1167.6, 1166.9, 1162.5,
	1148.6, 1122.0, 1107.7, 1180.8, 1189.1, 1189.3,
];

// DEZ24 pico 891 cm (16/12/2024 07h30) — platô pós-pico (mais novo primeiro)
const SERIE_DEZ24_PLATO: (number | null)[] = [
	888.3, 888.6, 889.0, 889.1, 889.3, 889.5,
	889.8, 889.9, 890.3, 890.5, 890.5, 890.7,
	890.8, 891.0, 891.1, 891.2, 891.2, 891.1,
	890.9, 891.1, 891.0, 891.0, 891.1, 891.2,
];

// ao vivo 27/09/2026 16h — Uvaia 646,7 cm, caindo 27,3 cm do pico (payload real)
const SERIE_AO_VIVO: (number | null)[] = [
	646.7, 648.2, 650.5, 652.8, 654.4, 656.9,
	658.6, 659.5, 659.7, 660.7, 660.9, 661.1,
	662.9, 664.1, 665.7, 667.4, 668.2, 669.4,
	670.2, 671.1, 671.5, 672.3, 673.1, 674,
];

function serie(niveis: (number | null)[]): HidroSeriePonto[] {
	return niveis.map((nivelCm) => ({
		dataHora: "2026-09-27 16:00:00",
		nivelCm,
		vazaoM3s: null,
		chuvaMm: null,
	}));
}

function est(codigo: string, over: Partial<HidroEstacao> = {}): HidroEstacao {
	const s = serie(SERIE_AO_VIVO);
	return {
		codigo,
		nome: "Uvaia",
		rio: "Tibagi",
		municipio: "Ponta Grossa",
		papel: "teste",
		nivelCm: 646.7,
		vazaoM3s: 353,
		chuvaMm: 0,
		dataHora: "2026-09-27 16:00:00",
		faixa: "alerta",
		serie: s,
		delta6hCm: -11.9,
		erro: null,
		// Como em fetchEstacao: a recessão é avaliada junto com a leitura.
		recessao: avaliarRecessao(s),
		disparaAlerta: sentinelaDisparaAlerta(codigo),
		...over,
	};
}

const SECO: ChuvaLocal = { p1h: 0, p6h: 2, p24h: 5, p72h: 30 };

describe("avaliarRecessao — limiares medidos (12 h sem subir + 30 cm)", () => {
	test("limiares são os medidos, não número redondo inventado", () => {
		expect(RECESSAO_LIMIARES.minHorasSemSubir).toBe(12);
		expect(RECESSAO_LIMIARES.minQuedaCm).toBe(30);
		expect(RECESSAO_LIMIARES.janelaHoras).toBe(24);
	});

	test("SUBIDA (OUT23 até o pico): o 12 h-sem-subir passa no topo, a QUEDA não — não confirma", () => {
		const r = avaliarRecessao(serie(SERIE_OUT23_SUBINDO));
		// O platô da crista deixa 19 leituras "sem subir" — por isso a queda é
		// obrigatória: sozinha, a condição de "não subiu" confirmaria numa cheia
		// em ascensão.
		expect(r.horasSemSubir).toBeGreaterThanOrEqual(12);
		expect(r.quedaJanelaCm).toBeLessThan(0);
		expect(r.confirmada).toBe(false);
	});

	test("OUT23 descendo com SEGUNDO PICO na janela: a contagem de 'sem subir' zera — não confirma", () => {
		const r = avaliarRecessao(serie(SERIE_OUT23_DESCENDO));
		expect(r.horasSemSubir).toBeLessThan(12);
		expect(r.confirmada).toBe(false);
	});

	test("DEZ24 pós-pico em PLATÔ: 23 h sem subir, mas só 2,9 cm de queda — não confirma (alerta fica)", () => {
		const r = avaliarRecessao(serie(SERIE_DEZ24_PLATO));
		expect(r.horasSemSubir).toBe(23);
		expect(r.quedaDesdePicoCm).toBeCloseTo(2.9, 1);
		expect(r.confirmada).toBe(false);
	});

	test("SET26 em recessão real na faixa alerta (812,5 cm): CONFIRMA", () => {
		const r = avaliarRecessao(serie(SERIE_SET26_ALERTA_RECESSO));
		expect(r.confirmada).toBe(true);
		expect(r.horasSemSubir).toBeGreaterThanOrEqual(12);
		expect(r.quedaJanelaCm).toBeGreaterThanOrEqual(30);
		expect(r.quedaDesdePicoCm).toBeGreaterThanOrEqual(30);
	});

	test("AO VIVO 27/09 (o caso reclamado): 12 h sem subir e 27,3 cm de queda — ainda NÃO confirma", () => {
		// Documenta o porquê de o alerta não cair na hora: faltavam 2,7 cm para o
		// limiar medido, o que a ~2 cm/h dá ~1-2 h. Não se baixa limiar para
		// "resolver hoje": o número vem da medição dos eventos reais.
		const r = avaliarRecessao(serie(SERIE_AO_VIVO));
		expect(r.horasSemSubir).toBe(23);
		expect(r.quedaJanelaCm).toBeCloseTo(27.3, 1);
		expect(r.confirmada).toBe(false);
	});

	test("série curta/buracos: nunca confirma sem histórico", () => {
		expect(avaliarRecessao([]).confirmada).toBe(false);
		expect(avaliarRecessao(serie([600, 590])).confirmada).toBe(false);
		expect(avaliarRecessao(serie([600, null, null, null])).confirmada).toBe(false);
	});

	test("queda de 30 cm EM 12 h sem nenhuma subida: confirma", () => {
		// Mais novo primeiro: agora 600 cm; a cada hora para trás o nível é
		// MAIOR (queda monotônica, sem repique) — 12 h antes já eram 630.
		const caindo = [600, 610, 620, 630, 640, 645, 648, 650, 652, 654, 656, 658, 660];
		const r = avaliarRecessao(serie(caindo));
		expect(r.confirmada).toBe(true);
		expect(r.horasSemSubir).toBe(12);
	});

	test("repique de 2 cm DENTRO da janela zera a contagem (não confirma)", () => {
		// Mesma queda, mas com um repique pequeno no meio: o rio parou de descer.
		const caindo = [600, 610, 620, 645, 640, 645, 648, 650, 652, 654, 656, 658, 660];
		const r = avaliarRecessao(serie(caindo));
		expect(r.confirmada).toBe(false);
		expect(r.horasSemSubir).toBeLessThan(12);
	});
});

describe("faixaComRecessao — o degrau (alerta sai, atenção fica)", () => {
	const rec = (confirmada: boolean) => ({
		confirmada,
		horasSemSubir: 12,
		quedaJanelaCm: 31,
		quedaDesdePicoCm: 31,
		picoCm: 700,
	});

	test("alerta → atenção; crítico → alerta (teto histórico continua alerta)", () => {
		expect(faixaComRecessao("alerta", rec(true))).toBe("atencao");
		expect(faixaComRecessao("critico", rec(true))).toBe("alerta");
	});

	test("atenção e normal não são tocados; recessão não confirmada não muda nada", () => {
		expect(faixaComRecessao("atencao", rec(true))).toBe("atencao");
		expect(faixaComRecessao("normal", rec(true))).toBe("normal");
		expect(faixaComRecessao("alerta", rec(false))).toBe("alerta");
		expect(faixaComRecessao("alerta", null)).toBe("alerta");
		expect(faixaComRecessao(null, rec(true))).toBe(null);
	});
});

describe("sentinelaDisparaAlerta — jusante não acende alerta de Ipiranga", () => {
	test("Uvaia (montante) dispara; Cebolão e Jataizinho (jusante) não", () => {
		expect(sentinelaDisparaAlerta("64444000")).toBe(true);
		expect(sentinelaDisparaAlerta("64504210")).toBe(false);
		expect(sentinelaDisparaAlerta("64507000")).toBe(false);
	});
});

describe("avaliarRisco — recessão REMOVE o alerta (ponta a ponta)", () => {
	test("Uvaia na faixa alerta DESCENDO (SET26 812,5 cm): alerta sai, resumo explica", () => {
		const uvaia = est("64444000", {
			nivelCm: 812.5,
			faixa: "alerta",
			serie: serie(SERIE_SET26_ALERTA_RECESSO),
			recessao: avaliarRecessao(serie(SERIE_SET26_ALERTA_RECESSO)),
			delta6hCm: -15,
		});
		const r = avaliarRisco([uvaia], SECO, 9); // setembro = convectivo
		expect(r.riscoCheia).toBe("ok");
		expect(r.riscoEnxurrada).toBe("ok");
		expect(r.resumoRisco).toContain("DESCENDO há 23 h");
		expect(r.resumoRisco).toContain("alerta removido");
		// A faixa medida continua no texto (transparência: o nível está alto).
		expect(r.resumoRisco).toContain("(faixa atenção)");
	});

	test("Uvaia na faixa alerta CAINDO só 27,3 cm (ao vivo): alerta FICA (falta evidência)", () => {
		const uvaia = est("64444000", { nivelCm: 646.7, faixa: "alerta" });
		const r = avaliarRisco([uvaia], SECO, 9);
		expect(r.riscoCheia).toBe("watch");
		expect(r.resumoRisco).toContain("faixa de alerta (P98 do ano hidrológico)");
	});

	test("faixa CRÍTICA em recessão continua alerta (água ainda acima do teto histórico)", () => {
		const uvaia = est("64444000", {
			nivelCm: 850,
			faixa: "critico",
			serie: serie(SERIE_SET26_ALERTA_RECESSO),
			recessao: avaliarRecessao(serie(SERIE_SET26_ALERTA_RECESSO)),
			delta6hCm: -15,
		});
		const r = avaliarRisco([uvaia], SECO, 9);
		expect(r.riscoCheia).toBe("watch");
	});

	test("jusante sozinha (Cebolão crítico + Jataizinho alerta) NÃO acende alerta com o Uvaia normal", () => {
		const uvaia = est("64444000", { nivelCm: 300, faixa: "normal", delta6hCm: 0 });
		const cebolao = est("64504210", {
			nome: "Cebolão",
			nivelCm: 395,
			faixa: "critico",
			serie: serie(SERIE_AO_VIVO),
			recessao: avaliarRecessao(serie(SERIE_AO_VIVO)),
		});
		const jataizinho = est("64507000", { nome: "Jataizinho (UHE Capivara)", nivelCm: 346, faixa: "alerta" });
		const r = avaliarRisco([uvaia, cebolao, jataizinho], SECO, 9);
		expect(r.riscoCheia).toBe("ok");
		expect(r.resumoRisco).not.toContain("faixa alerta (P98");
	});

	test("faixaEfetiva já calculada no payload é respeitada (caminho rápido)", () => {
		const uvaia = est("64444000", {
			nivelCm: 812.5,
			faixa: "alerta",
			faixaEfetiva: "atencao",
			serie: serie(SERIE_SET26_ALERTA_RECESSO),
			recessao: avaliarRecessao(serie(SERIE_SET26_ALERTA_RECESSO)),
			delta6hCm: -15,
		});
		expect(avaliarRisco([uvaia], SECO, 9).riscoCheia).toBe("ok");
	});

	test("chuva local forte mantém o alerta mesmo com o rio descendo (drenagem bloqueada)", () => {
		const uvaia = est("64444000", {
			nivelCm: 812.5,
			faixa: "alerta",
			serie: serie(SERIE_SET26_ALERTA_RECESSO),
			recessao: avaliarRecessao(serie(SERIE_SET26_ALERTA_RECESSO)),
			delta6hCm: -15,
		});
		const chuva: ChuvaLocal = { p1h: 4, p6h: 18, p24h: 40, p72h: 60 };
		expect(avaliarRisco([uvaia], chuva, 9).riscoCheia).toBe("watch");
	});
});
