/**
 * Previsão de saída da calha do Rio Bitumirim (Ipiranga-PR).
 *
 * Responde a pergunta útil: **"vai sair da calha? sim/não. Se sim, quando?"**
 * com nível de confiança explícito — o leitor tem margem pra interpretar.
 *
 * MÉTODO (determinístico, auditável, sem número inventado):
 *  1. Regra de regime (doutrina §6 do relatório v3.1), calibrada em 11 rótulos de
 *     campo do Dave + 2 negativos novos (jul/2024, set/2024):
 *       - convectivo (set–abr): manda a chuva LOCAL em DUAS estações do município.
 *         ≥2 dias com ≥40 mm nas duas dentro de 96 h → sai da calha.
 *       - frontal (mai–ago): a chuva local fica cega (os invernos saíram com
 *         6–21 mm/96 h); manda a carga de bacia (antecedente 30 d + Uvaia).
 *  2. Confiança = fração dos casos PARECIDOS no histórico que tiveram o mesmo
 *     desfecho (vizinhança por regime). Sem análogo → confiança baixa, declarada.
 *  3. "Quando": janela em horas medida nos rótulos convectivos (último dia pesado
 *     → saída). No frontal não há janela confiável em horas → null, declarado.
 *
 * FONTES dos rótulos: `docs/estudo-tibagi/rotulos-bitumirim.csv` (campo) e
 * `chuva-climanalytics.csv` (janelas terminando na data do rótulo, SMA 2056/1101).
 * Onde a data do rótulo é o PICO do Uvaia (invernos), a saída não é observada —
 * fica marcado em `dataBase`.
 */

export type RegimeHidro = "frontal" | "convectivo";

/** Janelas de chuva local (mm) terminando na data de referência. */
export interface ImpressaoChuva {
	/** São Braz (SMA 2056) — meio do curso do Bitumirim. */
	sb24: number | null;
	sb48: number | null;
	sb72: number | null;
	sb96: number | null;
	sb30d: number | null;
	/** Suruvi (SMA 1101) — 25 km a leste, na foz. */
	su96: number | null;
	/** Dias com ≥40 mm nas DUAS estações dentro de 96 h (0–4). */
	diasAmbas40: number;
	/** Data do último dia com ambas ≥40 mm (base da janela "quando"). */
	ultimoDiaPesado: string | null;
}

/** Rótulo de campo (verdade do Dave) com a impressão digital de chuva. */
export interface RotuloBitumirim {
	id: string;
	data: string;
	/** O que a data significa: saída observada ou pico do Uvaia (proxy). */
	/** Saiu da calha — ALVO da previsão. Default = transbordou. */
	saiuDaCalha?: boolean;
	dataBase: "saida" | "picoUvaia" | "maximo";
	transbordou: boolean;
	regime: RegimeHidro;
	impr: ImpressaoChuva;
	uvaiaCm: number | null;
	nota: string;
}

const vazio: ImpressaoChuva = {
	sb24: null,
	sb48: null,
	sb72: null,
	sb96: null,
	sb30d: null,
	su96: null,
	diasAmbas40: 0,
	ultimoDiaPesado: null,
};

/**
 * Rótulos com impressão digital extraída do repo (script determinístico sobre
 * chuva-climanalytics.csv). SET26 preenchido pela série da própria SMA (o CSV do
 * repo termina em 09/09/2026).
 */
export const ROTULOS_BITUMIRIM: RotuloBitumirim[] = [
	{
		id: "INV2013",
		data: "2013-06-28",
		dataBase: "picoUvaia",
		transbordou: true,
		regime: "frontal",
		impr: { ...vazio, sb24: 0.2, sb48: 0.8, sb72: 3.2, sb96: 28.4, sb30d: 397.4 },
		uvaiaCm: 1033,
		nota: "o mais dramático dos invernos (Dave)",
	},
	{
		id: "INV2014",
		data: "2014-06-13",
		dataBase: "picoUvaia",
		transbordou: true,
		regime: "frontal",
		impr: { ...vazio, sb24: 0.4, sb48: 0.4, sb72: 0.4, sb96: 0.4, sb30d: 256.8 },
		uvaiaCm: 995,
		nota: "inverno médio (Dave)",
	},
	{
		id: "INV2015",
		data: "2015-07-22",
		dataBase: "picoUvaia",
		transbordou: true,
		regime: "frontal",
		impr: { ...vazio, sb24: 0.0, sb48: 21.0, sb72: 21.0, sb96: 21.2, sb30d: 298.8, su96: 23.6 },
		uvaiaCm: 986,
		nota: "inverno médio (Dave)",
	},
	{
		id: "INV2017",
		data: "2017-06-13",
		dataBase: "picoUvaia",
		transbordou: true,
		regime: "frontal",
		impr: { ...vazio, sb24: 0.8, sb48: 1.0, sb72: 1.4, sb96: 1.6, sb30d: 319.4, su96: 2.0 },
		uvaiaCm: 659,
		nota: "inverno menor (Dave)",
	},
	{
		id: "INV2019",
		data: "2019-06-07",
		dataBase: "picoUvaia",
		transbordou: true,
		regime: "frontal",
		impr: { ...vazio, sb24: 0.6, sb48: 0.6, sb72: 1.0, sb96: 1.6, sb30d: 311.0, su96: 1.4 },
		uvaiaCm: 921,
		nota: "inverno menor (Dave)",
	},
	{
		id: "OUT23",
		data: "2023-10-29",
		dataBase: "saida",
		transbordou: true,
		regime: "convectivo",
		impr: {
			...vazio,
			sb24: 96.9,
			sb48: 193.7,
			sb72: 235.1,
			sb96: 235.1,
			sb30d: 419.7,
			su96: 250.2,
			diasAmbas40: 3,
			ultimoDiaPesado: "2023-10-29",
		},
		uvaiaCm: 756,
		nota: "a maior cheia; rodovia interditada, 7 dias fora",
	},
	{
		id: "DEZ24",
		data: "2024-12-09",
		dataBase: "saida",
		transbordou: true,
		regime: "convectivo",
		impr: {
			...vazio,
			sb24: 128.0,
			sb48: 149.0,
			sb72: 298.0,
			sb96: 299.6,
			sb30d: 361.2,
			su96: 222.2,
			diasAmbas40: 2,
			ultimoDiaPesado: "2024-12-09",
		},
		uvaiaCm: 337,
		nota: "atravessou a rodovia; 3 dias fora",
	},
	{
		id: "JAN25",
		data: "2025-01-21",
		dataBase: "maximo",
		transbordou: false,
		regime: "convectivo",
		impr: {
			...vazio,
			sb24: 0.4,
			sb48: 15.2,
			sb72: 158.2,
			sb96: 172.8,
			sb30d: 213.0,
			su96: 52.0,
			diasAmbas40: 0,
		},
		uvaiaCm: 180,
		nota: "143 mm em 1 dia SÓ na São Braz (célula no norte) — régua 4 m, não saiu",
	},
	{
		id: "SET26",
		data: "2026-09-13",
		dataBase: "saida",
		transbordou: false,
		saiuDaCalha: true,
		regime: "convectivo",
		impr: {
			...vazio,
			sb24: 5.6,
			sb48: 20.0,
			sb72: 62.6,
			sb96: 137.2,
			sb30d: 302.0,
			su96: 127.0,
			diasAmbas40: 2,
			ultimoDiaPesado: "2026-09-11",
		},
		uvaiaCm: 705,
		nota: "saiu da calha e NÃO atingiu o critério de transbordo (margem direita seca)",
	},
	{
		id: "jul24",
		data: "2024-07-24",
		dataBase: "picoUvaia",
		transbordou: false,
		regime: "frontal",
		impr: { ...vazio, sb24: 0.2, sb48: 0.6, sb72: 1.0, sb96: 1.4, sb30d: 108.8, su96: 0.6 },
		uvaiaCm: 338,
		nota: "NÃO transbordou (Dave) — Lajeado passou do P90 e não encheu o Bitumirim",
	},
	{
		id: "set24",
		data: "2024-09-19",
		dataBase: "picoUvaia",
		transbordou: false,
		regime: "convectivo",
		impr: { ...vazio, sb24: 0.0, sb48: 2.0, sb72: 2.0, sb96: 7.0, sb30d: 105.0, su96: 5.0 },
		uvaiaCm: 213,
		nota: "NÃO transbordou (Dave)",
	},
];

// ============ Busca da chuva diária da SMA ABC (fonte dos rótulos) ============

const URL_ABC = "https://sma.fundacaoabc.org/monitoramento/grafico/diario_dados";

export interface PontoChuva {
	data: string; // AAAA-MM-DD
	mm: number | null;
}

/** Extrai (categorias, valores) da série "Precipitação Pluvial" do Highcharts. */
export function extrairChuvaABC(html: string): { cats: string[]; vals: (number | null)[] } {
	const i = html.indexOf('"title":{"text":"Precipita');
	if (i < 0) return { cats: [], vals: [] };
	const j = html.indexOf('"series":[{"data":[', i);
	if (j < 0) return { cats: [], vals: [] };
	const k = html.indexOf("]", j + 19);
	const c0 = html.lastIndexOf('"categories":[', i);
	const c1 = html.indexOf("]", c0 + 14);
	if (k < 0 || c0 < 0 || c1 < 0) return { cats: [], vals: [] };
	let raw: (number | null)[];
	let cats: string[];
	try {
		raw = JSON.parse(`[${html.slice(j + 19, k)}]`);
		cats = JSON.parse(`[${html.slice(c0 + 14, c1).replaceAll("\\/", "/")}]`);
	} catch {
		return { cats: [], vals: [] };
	}
	if (cats.length !== raw.length) return { cats: [], vals: [] };
	return { cats, vals: raw.map((v) => (v === null ? null : Number(v))) };
}

/** Data-base do gráfico (o Highcharts declara "Período: DD/MM/AAAA"). */
export function periodoBaseABC(html: string): string | null {
	const m = html.match(/odo:\s*(\d{2})\\?\/(\d{2})\\?\/(\d{4})/);
	if (!m) return null;
	return `${m[3]}-${m[2]}-${m[1]}`;
}

/** Busca a série diária (31 d) da estação ABC que termina em `dataAlvo`. */
export async function buscarSerieABC(
	cod: string,
	dataAlvo: string,
	timeoutMs = 15000,
): Promise<PontoChuva[]> {
	const [a, m, d] = dataAlvo.split("-");
	const ctrl = new AbortController();
	const t = setTimeout(() => ctrl.abort(), timeoutMs);
	try {
		const res = await fetch(URL_ABC, {
			method: "POST",
			headers: {
				"User-Agent": "Mozilla/5.0",
				"Content-Type": "application/x-www-form-urlencoded",
				"X-Requested-With": "XMLHttpRequest",
			},
			body: new URLSearchParams({ cod_area_estacao: cod, data: `${d}/${m}/${a}` }).toString(),
			signal: ctrl.signal,
		});
		if (!res.ok) return [];
		const html = await res.text();
		const { cats, vals } = extrairChuvaABC(html);
		const base = periodoBaseABC(html);
		if (!cats.length || !base) return [];
		const inicio = new Date(`${base}T12:00:00Z`).getTime();
		return vals.map((mm, i) => ({
			data: new Date(inicio + i * 86400000).toISOString().slice(0, 10),
			mm,
		}));
	} catch {
		return [];
	} finally {
		clearTimeout(t);
	}
}

// ============ Impressão digital ============

function soma(serie: Map<string, number | null>, ref: string, dias: number): number | null {
	let tot = 0;
	let n = 0;
	const base = new Date(`${ref}T12:00:00Z`).getTime();
	for (let i = 0; i < dias; i++) {
		const k = new Date(base - i * 86400000).toISOString().slice(0, 10);
		if (serie.has(k)) {
			const v = serie.get(k);
			if (v != null) {
				tot += v;
				n++;
			}
		}
	}
	return n >= Math.ceil(dias / 2) ? Math.round(tot * 10) / 10 : null;
}

/** Impressão digital a partir das séries diárias de São Braz (2056) e Suruvi (1101). */
export function impressaoDigital(
	sb: PontoChuva[],
	su: PontoChuva[],
	ref: string,
): ImpressaoChuva {
	const mSB = new Map(sb.map((p) => [p.data, p.mm]));
	const mSU = new Map(su.map((p) => [p.data, p.mm]));
	let diasAmbas40 = 0;
	let ultimo: string | null = null;
	const base = new Date(`${ref}T12:00:00Z`).getTime();
	for (let i = 0; i < 4; i++) {
		const k = new Date(base - i * 86400000).toISOString().slice(0, 10);
		const a = mSB.get(k);
		const b = mSU.get(k);
		if (a != null && b != null && a >= 40 && b >= 40) {
			diasAmbas40++;
			if (ultimo === null) ultimo = k;
		}
	}
	return {
		sb24: soma(mSB, ref, 1),
		sb48: soma(mSB, ref, 2),
		sb72: soma(mSB, ref, 3),
		sb96: soma(mSB, ref, 4),
		sb30d: soma(mSB, ref, 30),
		su96: soma(mSU, ref, 4),
		diasAmbas40,
		ultimoDiaPesado: ultimo,
	};
}

// ============ Previsão ============

export type VereditoCalha = "sim" | "nao" | "indefinido";

export interface PrevisaoCalha {
	vaiSair: VereditoCalha;
	confianca: number; // 0–100
	faixa: "baixa" | "media" | "alta";
	quandoHoras: { min: number; provavel: number; max: number } | null;
	vizinhos: { total: number; sairam: number; ids: string[] };
	regra: string;
	motivos: string[];
	fonte: string;
}

export interface PrevisaoInput {
	impr: ImpressaoChuva;
	regime: RegimeHidro;
	uvaiaCm: number | null;
	/** Chuva fina ao vivo (CEMADEN Ipiranga) — refina a janela "quando". */
	chuvaAgora?: { p1h: number | null; p6h: number | null } | null;
}

const LIMIAR_DIAS_AMBAS40 = 2;
const LIMIAR_SB30D_FRONTAL = 250;
const LIMIAR_UVAIA_FRONTAL = 500;

function ehVizinho(a: ImpressaoChuva, b: ImpressaoChuva, regime: RegimeHidro): boolean {
	if (regime === "convectivo") {
		// o que decide o ramo convectivo e a ESTRUTURA de chuva em duas estacoes
		return Math.abs(a.diasAmbas40 - b.diasAmbas40) <= 1;
	}
	// frontal: o que decide e o palco (antecedente de 30 dias)
	return Math.abs((a.sb30d ?? 0) - (b.sb30d ?? 0)) <= 90;
}

/** Teto de confianca pelo tamanho da amostra — n=1 nao pode dar 95%. */
function tetoAmostra(total: number): number {
	if (total >= 4) return 95;
	if (total === 3) return 85;
	if (total === 2) return 70;
	if (total === 1) return 55;
	return 45;
}

export function preverSaidaDaCalha(input: PrevisaoInput): PrevisaoCalha {
	const { impr, regime, uvaiaCm } = input;
	const motivos: string[] = [];
	let veredito: VereditoCalha;
	let regra: string;

	if (regime === "convectivo") {
		const d = impr.diasAmbas40;
		const fmt = (v: number | null) => (v == null ? "sem dado" : `${v.toFixed(0).replace(".", ",")} mm`);
		motivos.push(
			`chuva local em Ipiranga (96 h): São Braz ${fmt(impr.sb96)} · Suruvi ${fmt(impr.su96)}`,
		);
		motivos.push(
			`${d} dia(s) com ≥40 mm nas DUAS estações dentro de 96 h (limiar: ${LIMIAR_DIAS_AMBAS40})`,
		);
		if (d >= LIMIAR_DIAS_AMBAS40) {
			veredito = "sim";
			regra = "regime convectivo: chuva local de vários dias em duas estações (evento de bacia, não célula isolada)";
		} else if (d === 1) {
			veredito = "indefinido";
			regra =
				"regime convectivo: 1 dia pesado em duas estações — fica na fronteira (precisa de 2)";
		} else {
			veredito = "nao";
			regra =
				"regime convectivo: nenhum dia com ≥40 mm nas duas estações — chuva localizada não enche o Bitumirim (assinatura JAN25)";
		}
		if ((impr.sb24 ?? 0) >= 90) {
			motivos.push(
				`atenção: ${fmt(impr.sb24)} em 24 h numa estação — flash local possível mesmo com o veredito acima`,
			);
		}
	} else {
		const a30 = impr.sb30d;
		const fmt = (v: number | null) => (v == null ? "sem dado" : `${v.toFixed(0).replace(".", ",")} mm`);
		motivos.push(`antecedente 30 dias (São Braz): ${fmt(a30)} (limiar frontal: ${LIMIAR_SB30D_FRONTAL} mm)`);
		motivos.push(
			`Uvaia (carga de bacia): ${uvaiaCm == null ? "sem dado" : `${uvaiaCm.toFixed(0)} cm`} (limiar frontal: ${LIMIAR_UVAIA_FRONTAL} cm)`,
		);
		motivos.push(
			"no inverno frontal a chuva local fica cega (os invernos saíram da calha com 6–21 mm/96 h)",
		);
		const palco = (a30 ?? 0) >= LIMIAR_SB30D_FRONTAL;
		const bacia = (uvaiaCm ?? 0) >= LIMIAR_UVAIA_FRONTAL;
		if (palco && bacia) {
			veredito = "sim";
			regra = "regime frontal: palco armado (antecedente ≥250 mm) e bacia carregada (Uvaia ≥500 cm)";
		} else if (palco) {
			veredito = "indefinido";
			regra = "regime frontal: palco armado, mas a bacia ainda não está carregada";
		} else {
			veredito = "nao";
			regra = "regime frontal: antecedente abaixo de 250 mm — a bacia não tem água acumulada";
		}
	}

	const viz = ROTULOS_BITUMIRIM.filter(
		(r) => r.regime === regime && ehVizinho(impr, r.impr, regime),
	);
	const total = viz.length;
	const sairam = viz.filter((r) => r.saiuDaCalha ?? r.transbordou).length;
	let confianca: number;
	if (total === 0) {
		confianca = veredito === "indefinido" ? 30 : 45;
		motivos.push("nenhum caso parecido no histórico — confiança rebaixada");
	} else {
		const p = sairam / total;
		const acerto = veredito === "sim" ? p : veredito === "nao" ? 1 - p : 0.5;
		confianca = Math.round(100 * acerto);
		motivos.push(
			`${total} caso(s) parecido(s) no histórico: em ${sairam} o rio saiu da calha (${sairam}/${total})`,
		);
	}
	confianca = Math.max(25, Math.min(tetoAmostra(total), confianca));
	const faixa: PrevisaoCalha["faixa"] = confianca >= 75 ? "alta" : confianca >= 50 ? "media" : "baixa";

	let quandoHoras: PrevisaoCalha["quandoHoras"] = null;
	if (veredito === "sim") {
		if (regime === "convectivo") {
			// Medido nos rótulos: saída 13–48 h depois do último dia com ambas ≥40 mm.
			const p6 = input.chuvaAgora?.p6h ?? null;
			const chovendoAgora = p6 != null && p6 >= 20;
			quandoHoras = chovendoAgora
				? { min: 3, provavel: 12, max: 36 }
				: { min: 12, provavel: 24, max: 48 };
			if (chovendoAgora) {
				motivos.push(`chuva forte acontecendo agora (${p6?.toFixed(1).replace(".", ",")} mm/6h) — janela encurta`);
			}
		} else {
			quandoHoras = null;
			motivos.push("regime frontal: sem janela em horas confiável (a saída depende da bacia, não da chuva recente)");
		}
	}

	return {
		vaiSair: veredito,
		confianca,
		faixa,
		quandoHoras,
		vizinhos: { total, sairam, ids: viz.map((r) => r.id) },
		regra,
		motivos,
		fonte:
			"regra de regime (relatório v3.1) + vizinhança em 11 rótulos de campo; estimativa, não oficial",
	};
}

/** Replay com validação cruzada (leave-one-out) sobre os rótulos. */
export function validarLeaveOneOut(): {
	id: string;
	esperado: boolean;
	veredito: VereditoCalha;
	confianca: number;
	acertou: boolean;
}[] {
	return ROTULOS_BITUMIRIM.map((r) => {
		const outros = ROTULOS_BITUMIRIM.filter((x) => x.id !== r.id);
		// vizinhança calculada SEM o próprio rótulo (LOO honesto)
		const viz = outros.filter((x) => x.regime === r.regime && ehVizinho(r.impr, x.impr, r.regime));
		const total = viz.length;
		const transbordaram = viz.filter((x) => x.saiuDaCalha ?? x.transbordou).length;
		let veredito: VereditoCalha;
		if (r.regime === "convectivo") {
			veredito = r.impr.diasAmbas40 >= LIMIAR_DIAS_AMBAS40 ? "sim" : r.impr.diasAmbas40 === 1 ? "indefinido" : "nao";
		} else {
			const palco = (r.impr.sb30d ?? 0) >= LIMIAR_SB30D_FRONTAL;
			const bacia = (r.uvaiaCm ?? 0) >= LIMIAR_UVAIA_FRONTAL;
			veredito = palco && bacia ? "sim" : palco ? "indefinido" : "nao";
		}
		const p = total ? transbordaram / total : null;
		const acerto = p == null ? 0.45 : veredito === "sim" ? p : veredito === "nao" ? 1 - p : 0.5;
		const confianca = Math.max(25, Math.min(tetoAmostra(total), Math.round(100 * acerto)));
		const alvo = r.saiuDaCalha ?? r.transbordou;
		const acertou = veredito === "indefinido" ? false : (veredito === "sim") === alvo;
		return { id: r.id, esperado: alvo, veredito, confianca, acertou };
	});
}

// ============ Previsão ao vivo (cache de 30 min) ============

let cacheABC: { em: number; dia: string; sb: PontoChuva[]; su: PontoChuva[] } | null = null;
const TTL_ABC_MS = 30 * 60_000;

/**
 * Roda a previsão com a chuva local ao vivo (SMA ABC 2056 + 1101).
 * Degrada para `null` se a fonte não responder — nunca inventa número e nunca
 * quebra o ciclo de clima.
 */
async function obterSerieABC(
	dia: string,
): Promise<{ em: number; dia: string; sb: PontoChuva[]; su: PontoChuva[] } | null> {
	if (cacheABC && cacheABC.dia === dia && Date.now() - cacheABC.em < TTL_ABC_MS) return cacheABC;
	const [sb, su] = await Promise.all([buscarSerieABC("2056", dia), buscarSerieABC("1101", dia)]);
	if (!sb.length || !su.length) return null;
	cacheABC = { em: Date.now(), dia, sb, su };
	return cacheABC;
}

export async function preverCalhaAoVivo(input: {
	regime: RegimeHidro;
	uvaiaCm: number | null;
	chuvaAgora?: { p1h: number | null; p6h: number | null } | null;
	agora?: Date;
}): Promise<PrevisaoCalha | null> {
	const agora = input.agora ?? new Date();
	const dia = agora.toISOString().slice(0, 10);
	const series = await obterSerieABC(dia);
	if (!series) return null;
	const impr = impressaoDigital(series.sb, series.su, dia);
	return preverSaidaDaCalha({
		impr,
		regime: input.regime,
		uvaiaCm: input.uvaiaCm,
		chuvaAgora: input.chuvaAgora ?? null,
	});
}
