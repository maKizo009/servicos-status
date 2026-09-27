/**
 * Recessão do nível (27/09/2026) — o alerta CAI quando o rio está DIMINUINDO.
 *
 * Pedido do dono: o card mostrava "Rio Uvaia em alerta" com o nível CAINDO e
 * "risco de transbordar: baixo". Causa: o `watch` ligava com qualquer sentinela
 * na faixa P98 (`algumaEmAlerta`) e a ÚNICA saída era o nível voltar abaixo da
 * faixa — com o Uvaia em 6,47 m caindo ~2 cm/h isso levava dias.
 *
 * Os arrays abaixo são SÉRIES REAIS da telemetria ANA (DadosHidrometeorologicos),
 * na ordem que o backend usa: MAIS NOVO PRIMEIRO, buracos de sensor como `null`.
 * Cada caso está ancorado num instante real (comentário acima do array).
 */
import { describe, expect, test } from "bun:test";
import {
	RECESSAO_LIMIARES,
	avaliarRecessao,
	avaliarRisco,
	faixaComRecessao,
	preservarHidro,
	sentinelaDisparaAlerta,
	type HidroEstacao,
	type HidroSeriePonto,
	type HidroState,
} from "../src/ana-hidro.js";

// OUT23 — 72 slots ATÉ o pico de 1189.3 cm (2023-11-03 06:00:00): cheia EM ASCENSÃO, não pode confirmar
const SERIE_OUT23_SUBINDO: (number | null)[] = [
	1189.3, 1188.9, 1188.9, 1189.1, 1189.0, 1189.1,
	1188.6, 1189.0, 1188.1, 1188.1, 1187.8, 1187.7,
	1187.2, 1187.3, 1186.8, 1186.9, 1186.3, 1186.3,
	1186.2, 1185.9, 1184.6, 1184.9, 1184.9, 1184.7,
	1184.3, 1184.2, 1183.6, 1183.4, 1183.2, 1182.2,
	1182.3, 1182.3, 1181.7, 1181.6, 1181.2, 1181.0,
	1180.4, 1180.1, 1179.3, 1179.3, 1178.6, 1178.4,
	1178.2, 1178.2, 1177.4, 1177.3, 1176.5, 1176.2,
	1175.9, 1175.6, 1175.0, 1174.4, 1173.8, 1173.7,
	1173.1, 1172.6, 1172.3, 1172.5, 1171.8, 1171.2,
	1170.9, 1170.1, 1169.6, 1169.3, 1168.6, 1168.0,
	1167.7, 1167.4, 1167.1, 1166.4, 1166.1, 1165.1,
];

// OUT23 — 72 slots a partir do pico (2023-11-11 03:15:00 no topo): tem SEGUNDO PICO no meio
const SERIE_OUT23_DESCENDO: (number | null)[] = [
	1083.3, 1083.5, 1084.0, 1084.4, 1084.8, 1085.2,
	1085.6, 1086.0, 1086.4, 1086.6, 1087.0, 1087.5,
	1087.9, 1088.3, 1088.8, 1089.1, 1089.5, 1089.8,
	1090.2, 1090.5, 1090.9, 1091.4, 1091.8, 1092.1,
	1092.7, 1092.9, 1093.3, 1093.7, 1094.0, 1094.5,
	1094.9, 1095.2, 1095.5, 1095.9, 1096.3, 1096.7,
	1096.9, 1097.2, 1097.7, 1098.0, 1098.4, 1098.6,
	1098.9, 1099.4, null, null, null, null,
	null, null, null, null, null, null,
	null, null, null, 1172.6, 1172.1, 1171.5,
	1170.2, 1169.9, 1168.6, 1167.6, 1166.9, 1162.5,
	1148.6, 1122.0, 1107.7, 1180.8, 1189.1, 1189.3,
];

// DEZ24 — 72 slots a partir do pico (2024-12-17 01:15:00 no topo): PLATÔ, não desce
const SERIE_DEZ24_PLATO: (number | null)[] = [
	875.0, 875.1, 875.5, 875.7, 875.9, 876.2,
	876.8, 876.7, 876.9, 877.3, 877.6, 878.2,
	879.6, 881.7, 882.4, 883.0, 883.2, 883.5,
	883.8, 883.9, 883.9, 884.0, 883.9, 884.1,
	883.9, 883.8, 883.6, 883.7, 883.8, 883.9,
	884.0, 883.9, 884.0, 884.2, 884.4, 884.4,
	884.8, 885.1, 885.5, 885.7, 886.0, 886.4,
	886.9, 887.0, 887.0, 887.3, 887.7, 888.0,
	888.3, 888.6, 889.0, 889.1, 889.3, 889.5,
	889.8, 889.9, 890.3, 890.5, 890.5, 890.7,
	890.8, 891.0, 891.1, 891.2, 891.2, 891.1,
	890.9, 891.1, 891.0, 891.0, 891.1, 891.2,
];

// SET26 — 72 slots até 2026-09-19 10:00:00 = o instante REAL em que a regra confirma (31.3 cm abaixo do pico de 910.6 cm, sem subir 58 h)
const SERIE_SET26_ALERTA_RECESSO: (number | null)[] = [
	879.3, 880.7, 881.7, 882.7, 883.5, 883.7,
	884.5, 885.7, 887.6, 889.2, 890.7, 891.8,
	892.6, 892.9, 893.4, 894.0, 894.2, 894.7,
	895.4, 896.8, 898.2, 900.0, 901.2, 902.4,
	903.2, 904.0, 904.0, 904.2, 904.1, 904.1,
	904.4, 904.9, 905.8, 906.4, 907.2, 907.4,
	908.1, 907.8, 907.7, 907.3, 907.7, 907.9,
	907.7, 908.0, 908.7, 909.3, 910.2, 910.6,
	910.2, 909.2, 908.3, 907.4, 906.6, 906.0,
	905.4, 905.5, 905.2, 904.9, 904.2, 902.3,
	900.6, 899.1, 898.3, 896.9, 895.8, 895.1,
	894.8, 894.5, 893.9, 893.1, 892.2, 890.2,
];

// SET26 — 72 slots até 2026-09-17 22:00:00 (36 h antes): ainda NO PICO, não confirma
const SERIE_SET26_PLATO: (number | null)[] = [
	908.1, 907.8, 907.7, 907.3, 907.7, 907.9,
	907.7, 908.0, 908.7, 909.3, 910.2, 910.6,
	910.2, 909.2, 908.3, 907.4, 906.6, 906.0,
	905.4, 905.5, 905.2, 904.9, 904.2, 902.3,
	900.6, 899.1, 898.3, 896.9, 895.8, 895.1,
	894.8, 894.5, 893.9, 893.1, 892.2, 890.2,
	886.6, 884.3, 881.9, 880.0, 878.5, 876.9,
	875.6, 873.8, 871.8, 869.2, 866.7, 863.9,
	861.1, 858.2, 855.7, 852.6, 850.5, 848.5,
	846.7, 844.8, 842.7, 840.1, 836.5, 832.8,
	828.7, 824.5, 820.6, 816.9, 813.3, 810.6,
	807.3, 804.6, 801.0, 797.4, 793.6, 789.7,
];

// ao vivo 27/09/2026 — Uvaia 646,7 cm, 27,3 cm abaixo do pico (payload real de produção)
const SERIE_AO_VIVO: (number | null)[] = [
	646.7, 648.2, 650.5, 652.8, 654.4, 656.9,
	658.6, 659.5, 659.7, 660.7, 660.9, 661.1,
	662.9, 664.1, 665.7, 667.4, 668.2, 669.4,
	670.2, 671.1, 671.5, 672.3, 673.1, 674,
];

const serie = (niveis: (number | null)[]): HidroSeriePonto[] =>
	niveis.map((nivelCm) => ({
		dataHora: "2026-01-01 00:00:00",
		nivelCm,
		vazaoM3s: null,
		chuvaMm: null,
	}));

const estacao = (niveis: (number | null)[]): HidroEstacao => {
	const s = serie(niveis);
	const ultimo = s.find((p) => p.nivelCm != null)!;
	const recessao = avaliarRecessao(s);
	const faixa = "alerta" as const;
	return {
		codigo: "64444000",
		nome: "Uvaia",
		rio: "Rio Uvaia",
		municipio: "Ipiranga",
		papel: "sentinela da bacia do Bitumirim",
		nivelCm: ultimo.nivelCm,
		faixa,
		faixaEstendida: faixa,
		faixaEfetiva: faixaComRecessao(faixa, recessao),
		disparaAlerta: true,
		tendencia: "descendo",
		delta6hCm: -10,
		chuvaMm: 0,
		serie: s.slice(0, 24),
		recessao,
	} as HidroEstacao;
};

describe("limiares da recessão (medidos, não chutados)", () => {
	test("pico de 72 h, 12 h sem subir, 30 cm desde o pico", () => {
		expect(RECESSAO_LIMIARES.janelaPicoHoras).toBe(72);
		expect(RECESSAO_LIMIARES.minHorasSemSubir).toBe(12);
		expect(RECESSAO_LIMIARES.minQuedaCm).toBe(30);
	});

	test("queda de 30 cm em 12 h sem nenhum repique: confirma", () => {
		// Mais novo primeiro: agora 600 cm e, indo para trás, cada hora é MAIOR
		// (queda monótona). Pico da janela: 690 cm, 90 cm acima.
		const caindo = [600, 605, 610, 615, 620, 625, 630, 635, 640, 645, 650, 655, 660, 670, 680, 690];
		const r = avaliarRecessao(serie(caindo));
		expect(r.confirmada).toBe(true);
		expect(r.horasSemSubir).toBeGreaterThanOrEqual(12);
		expect(r.quedaDesdePicoCm).toBe(90);
	});

	test("queda de 25 cm NÃO confirma (a fronteira medida é 26 cm)", () => {
		// Com 25 cm a regra confirmava 9 h DURANTE a subida do OUT23 — 30 cm dá
		// 4 cm de margem sobre a fronteira segura.
		const r = avaliarRecessao(serie([655, 660, 665, 670, 675, 680]));
		expect(r.horasSemSubir).toBe(5);
		expect(r.confirmada).toBe(false);
	});

	test("subida forte e curta não confirma (nada de queda)", () => {
		const r = avaliarRecessao(serie([700, 690, 680, 670, 660]));
		expect(r.quedaDesdePicoCm).toBe(0);
		expect(r.confirmada).toBe(false);
	});

	test("série vazia ou curta não explode", () => {
		expect(avaliarRecessao([]).confirmada).toBe(false);
		expect(avaliarRecessao(serie([null, null])).confirmada).toBe(false);
		expect(avaliarRecessao(serie([640, null, 660, 670])).picoCm).toBe(670);
	});
});

describe("eventos históricos reais da ANA", () => {
	test("OUT23 — 72 h ATÉ o pico: cheia EM ASCENSÃO, não confirma", () => {
		// O erro fatal seria limpar o alerta com a cheia ainda subindo. Aqui o
		// "sem subir" já dá 19 h; quem barra é a queda desde o pico (0 cm).
		const r = avaliarRecessao(serie(SERIE_OUT23_SUBINDO));
		expect(r.horasSemSubir).toBeGreaterThanOrEqual(12);
		expect(r.quedaDesdePicoCm).toBe(0);
		expect(r.confirmada).toBe(false);
	});

	test("OUT23 — 72 h a partir do pico (com 2º pico no meio): confirma", () => {
		const r = avaliarRecessao(serie(SERIE_OUT23_DESCENDO));
		expect(r.confirmada).toBe(true);
		expect(r.horasSemSubir).toBeGreaterThanOrEqual(12);
		expect(r.quedaDesdePicoCm).toBeGreaterThanOrEqual(30);
	});

	test("DEZ24 — 72 h a partir do pico: PLATÔ, o alerta FICA", () => {
		// O rio fica dias em platô depois do pico: a água continua alta e a
		// queda não chega perto dos 30 cm — a regra não pode derrubar o alerta.
		const r = avaliarRecessao(serie(SERIE_DEZ24_PLATO));
		expect(r.confirmada).toBe(false);
		expect(r.quedaDesdePicoCm).toBeLessThan(RECESSAO_LIMIARES.minQuedaCm);
	});

	test("SET26 — o instante real em que a regra confirma (19/09 10h)", () => {
		const r = avaliarRecessao(serie(SERIE_SET26_ALERTA_RECESSO));
		expect(r.confirmada).toBe(true);
		expect(r.horasSemSubir).toBeGreaterThanOrEqual(12);
		expect(r.quedaDesdePicoCm).toBeGreaterThanOrEqual(30);
	});

	test("SET26 — 36 h ANTES disso: ainda no pico, não confirma", () => {
		const r = avaliarRecessao(serie(SERIE_SET26_PLATO));
		expect(r.confirmada).toBe(false);
		expect(r.quedaDesdePicoCm).toBeLessThan(RECESSAO_LIMIARES.minQuedaCm);
	});

	test("AO VIVO (payload de produção 27/09): 27,3 cm abaixo do pico → ainda não", () => {
		// O caso reclamado no mesmo dia: 23 h sem subir, mas 27,3 cm de queda —
		// faltam ~3 cm (≈2 h de recessão) para o alerta cair. Honesto: a regra
		// não remove alerta 27 cm abaixo de um pico de cheia.
		const r = avaliarRecessao(serie(SERIE_AO_VIVO));
		expect(r.horasSemSubir).toBeGreaterThanOrEqual(12);
		expect(r.quedaDesdePicoCm).toBeCloseTo(27.3, 1);
		expect(r.confirmada).toBe(false);
	});
});

describe("recessão tira UM degrau da faixa", () => {
	test("alerta → atenção; crítico → alerta; atenção/normal intactos", () => {
		const conf = { confirmada: true, horasSemSubir: 20, quedaDesdePicoCm: 40, picoCm: 900, atualCm: 860 };
		const nao = { ...conf, confirmada: false };
		expect(faixaComRecessao("alerta", conf)).toBe("atencao");
		expect(faixaComRecessao("critico", conf)).toBe("alerta");
		expect(faixaComRecessao("atencao", conf)).toBe("atencao");
		expect(faixaComRecessao("normal", conf)).toBe("normal");
		expect(faixaComRecessao("alerta", nao)).toBe("alerta");
		expect(faixaComRecessao(null, conf)).toBe(null);
		expect(faixaComRecessao("alerta", null)).toBe("alerta");
	});

	test("a recessão NÃO pode ser um gatilho de cabelo: 12 h exatas bastam", () => {
		const exato = [600, 610, 620, 630, 640, 650, 660, 670, 680, 690, 700, 710, 712];
		const r = avaliarRecessao(serie(exato));
		expect(r.horasSemSubir).toBe(12);
		expect(r.confirmada).toBe(true);
	});
});

describe("risco combinado (o alerta do card)", () => {
	const reprovada: HidroEstacao = {
		...estacao(SERIE_AO_VIVO),
		// como o payload de hoje: na faixa alerta, caindo
		faixa: "alerta",
		faixaEfetiva: "atencao",
		recessao: { confirmada: true, horasSemSubir: 23, quedaDesdePicoCm: 32, picoCm: 674, atualCm: 642 },
	};

	test("rio na faixa alerta COM recessão confirmada não gera mais watch", () => {
		const risco = avaliarRisco([reprovada], null, 9);
		expect(risco.riscoCheia).not.toBe("watch");
		expect(risco.resumoRisco).not.toContain("na faixa de alerta");
	});

	test("rio na faixa alerta SEM recessão continua disparando watch", () => {
		const sem = { ...reprovada, faixaEfetiva: "alerta" as const };
		const risco = avaliarRisco([sem], null, 9);
		expect(risco.riscoCheia).toBe("watch");
		expect(risco.resumoRisco).toContain("na faixa de alerta");
	});

	test("sentinela marcada com disparaAlerta:false não acende o alerta", () => {
		// Jusante (Cebolão/Jataizinho) mede a água que JÁ passou por Ipiranga:
		// os dados ficam na API, mas não acendem o alerta do card.
		expect(sentinelaDisparaAlerta("64444000")).toBe(true); // Uvaia
		expect(sentinelaDisparaAlerta("64504210")).toBe(false); // Cebolão
		expect(sentinelaDisparaAlerta("64507000")).toBe(false); // Jataizinho
		expect(sentinelaDisparaAlerta("99999999")).toBe(true); // desconhecida: conservador
	});
});

describe("ANA fora do ar não apaga o card do rio", () => {
	const comDados: HidroState = {
		estacoes: [estacao(SERIE_AO_VIVO)],
		fonte: "ANA Hidro (telemetria)",
		atualizadoEm: 1790543000000,
		riscoEnxurrada: "ok",
		riscoCheia: "watch",
		ifl: null,
		regime: null,
		previsao: null,
		resumoRisco: "Uvaia em nível de alerta",
	};
	// ciclo em que a ANA não respondeu (timeout medido em produção na Vercel)
	const falhou: HidroState = {
		...comDados,
		estacoes: [
			{
				...estacao(SERIE_AO_VIVO),
				nivelCm: null,
				faixa: null,
				faixaEfetiva: null,
				serie: [],
				delta6hCm: null,
				recessao: null,
				erro: "The operation was aborted due to timeout",
			},
		],
		atualizadoEm: null,
		riscoCheia: "ok",
		resumoRisco: "Triangulação indisponível no momento (sentinelas sem dados).",
	};

	test("ciclo com dados passa direto e marca desatualizado:false", () => {
		const r = preservarHidro(comDados, null);
		expect(r.estacoes[0].nivelCm).toBe(646.7);
		expect(r.desatualizado).toBe(false);
	});

	test("ANA falhou: mantém a última leitura boa, marcada como desatualizada", () => {
		const r = preservarHidro(falhou, comDados);
		expect(r.estacoes[0].nivelCm).toBe(646.7); // o card NÃO fica sem número
		expect(r.desatualizado).toBe(true);
		expect(r.riscoCheia).toBe("watch"); // risco conhecido, não um "ok" falso
		expect(r.erro).toContain("timeout"); // motivo, para diagnóstico
	});

	test("falhou e nunca houve leitura boa: devolve o ciclo vazio como veio", () => {
		const r = preservarHidro(falhou, null);
		expect(r.estacoes[0].nivelCm).toBe(null);
		expect(r.desatualizado).not.toBe(true);
		expect(preservarHidro(falhou, { ...comDados, estacoes: [] }).estacoes[0].nivelCm).toBe(null);
	});
});
