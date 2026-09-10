/**
 * ANA Hidro — triangulação fluviométrica para o Monitor Ipiranga.
 *
 * Ipiranga/PR (900 km², bacia do Tibagi/Bitumirim) NÃO tem estação
 * fluviométrica ativa dentro da malha — confirmado no HidroWeb/IAT.
 * A saída é triangular com 3 sentinelas telemétricas na calha do
 * Rio Tibagi que cercam o município.
 *
 * Fonte pública: telemetriaws1.ana.gov.br/ServiceANA.asmx
 * Método: DadosHidrometeorologicos (sem auth, XML).
 * Cada sentinela retorna série horária com Nivel (cm), Vazao (m³/s) e Chuva (mm).
 *
 * Integrado no mesmo cron de 10 min (api/cron → syncWeatherCycle) e
 * exposto no WeatherState.hidro + /llms.txt + /api/hidro.
 */

const REQUEST_TIMEOUT_MS = 15_000;

// 3 sentinelas na calha do Tibagi — montante→jusante em relação à foz do
// Bitumirim (-25,0049, -50,4279). CORREÇÃO 11/09/2026 (auditoria Antigravity
// + mapa OSM): a foz fica ~110 km ao SUL da barragem de Mauá (-24,0419),
// fora do reservatório (cauda em -24,2946). Ou seja: Antas (1,1 km a jusante
// da usina) mede água INDO EMBORA de Ipiranga — foi REMOVIDA do ciclo.
// Uvaia (alto Tibagi, Ponta Grossa) é a sentinela de montante de verdade.
export const SENTINELAS = [
	{
		codigo: "64444000",
		nome: "Uvaia",
		rio: "Tibagi",
		papel: "Montante — onda vindo do alto Tibagi em direção à foz",
		municipio: "Ponta Grossa",
	},
	{
		codigo: "64504210",
		nome: "Cebolão",
		rio: "Tibagi",
		papel: "Central — calha na altura da foz do Bitumirim",
		municipio: "Castro",
	},
	{
		codigo: "64507000",
		nome: "Jataizinho (UHE Capivara)",
		rio: "Tibagi",
		papel: "Jusante — confirma escoamento (não prevê Ipiranga)",
		municipio: "Jataizinho",
	},
] as const;

/**
 * Faixas de referência por sentinela — P90/P98 de 365 DIAS reais
 * (10/09/2025–10/09/2026, ciclo hidrológico completo). CORREÇÃO 11/09/2026:
 * as faixas anteriores (180 dias mar–set) excluíam a estação chuvosa e
 * subestimavam os percentis (auditoria Antigravity). Lixo de sensor
 * (nível 777777.7 = código de falha) sempre filtrado.
 *
 * - 64444000 Uvaia: nível P90 385 / P98 455 (máx ano 513); vazão P98 225
 * - 64504210 Cebolão: nível P90 337 / P98 360 (máx 419); vazão P98 1119
 * - 64507000 Jataizinho: nível P90 263 / P98 301 (máx 404); vazão P98 949
 *   (display/escoamento — fora do cálculo do IBR)
 *
 * São faixas RELATIVAS (percentil), não cotas oficiais de inundação.
 * Recalibrar anualmente (série longa do DadosHidrometeorologicos).
 */
export const FAIXAS: Record<
	string,
	{ atencaoCm: number; alertaCm: number; vazaoP98: number }
> = {
	"64444000": { atencaoCm: 385, alertaCm: 455, vazaoP98: 225 },
	"64504210": { atencaoCm: 337, alertaCm: 360, vazaoP98: 1119 },
	"64507000": { atencaoCm: 263, alertaCm: 301, vazaoP98: 949 },
};

/**
 * Tetos históricos — picos medidos nos 3 eventos de referência:
 * - OUT23 (enchente histórica, fim out/início nov 2023): chuva 323 mm/4d em
 *   São Braz + 257 mm em Suruvi + 90 mm em Castro; Uvaia 1189 cm,
 *   Cebolão 517 cm, Jataizinho 534 cm/3061 m³/s, Bitumirim 8 m em Ipiranga
 *   (4x o normal de ~2 m, ~7 mil atingidos — G1/Defesa Civil 31/10/2023).
 * - DEZ24 (cheia regional, 07-09/12/2024): 149+128 mm em São Braz,
 *   106+99 mm em Suruvi; Uvaia 815 cm, Cebolão 391 cm,
 *   Jataizinho 366 cm/1430 m³/s (pico com ~3-6 dias de atraso da chuva).
 * - JAN25 (flash local, 19/01/2025): 143 mm/dia em São Braz (19 mm em Suruvi
 *   a 11 km — tromba hiper-localizada); Tibagi CALMO (Cebolão 325 cm,
 *   Jataizinho 256 cm, abaixo do P90). Prova: sentinela não vê flash local.
 * Antas (fora do ciclo desde 11/09/2026 — a jusante da foz) mantida só como
 * referência histórica: OUT23 903 cm/2683 m³/s, DEZ24 622/1366.
 */
export const TETOS_HISTORICOS = {
	out23: {
		uvaiaCm: 1189,
		cebolaoCm: 517,
		jataizinhoCm: 534,
		chuvaSpBrazMm: 323,
		bitumirimM: 8,
	},
	dez24: {
		uvaiaCm: 815,
		cebolaoCm: 391,
		jataizinhoCm: 366,
		chuvaSpBrazMm: 298,
		bitumirimM: null,
	},
	jan25: {
		uvaiaCm: null,
		cebolaoCm: 325,
		jataizinhoCm: 256,
		chuvaSpBrazMm: 143,
		bitumirimM: null,
	},
} as const;

/** Nível crítico = teto DEZ24 (cheia regional recente, abaixo da histórica). */
export const NIVEL_CRITICO: Record<string, number> = {
	"64444000": TETOS_HISTORICOS.dez24.uvaiaCm,
	"64504210": TETOS_HISTORICOS.dez24.cebolaoCm,
	"64507000": TETOS_HISTORICOS.dez24.jataizinhoCm,
};

/** Faixa estendida com o estágio crítico (≥ teto DEZ24). */
export function faixaEstendida(
	codigo: string,
	nivelCm: number | null,
): "normal" | "atencao" | "alerta" | "critico" | null {
	if (nivelCm == null) return null;
	const crit = NIVEL_CRITICO[codigo];
	if (crit != null && nivelCm >= crit) return "critico";
	return faixaNivel(codigo, nivelCm);
}

export type NivelIBR = "verde" | "amarelo" | "laranja" | "vermelho";

export interface ResultadoIBR {
	score: number;
	nivel: NivelIBR;
	motivos: string[];
}

/**
 * Índice de Bloqueio por Remanso (IBR) v2 — física corrigida 11/09/2026.
 * A v1 usava Antas (1,1 km a JUSANTE da foz, mede água indo embora) como
 * "descarga Mauá causando remanso" — impossível hidraulicamente (auditoria
 * Antigravity + mapa OSM: foz a ~110 km ao sul da barragem, fora do
 * reservatório). A v2 usa só o que está a MONTANTE da foz: Uvaia (onda
 * vindo) + Cebolão (calha na foz) + chuva local.
 * Pesos: onda de montante 0.4 + corpo receptor 0.4/0.6 + chuva local 0.2.
 * Estágios: <0.3 verde · 0.3–0.5 amarelo · 0.5–0.8 laranja · ≥0.8 vermelho.
 */
export function calcularIBR(input: {
	nUvaia: number | null;
	deltaUvaia6h: number | null;
	nCebolao: number | null;
	chuvaIpiranga6h: number | null;
}): ResultadoIBR {
	const motivos: string[] = [];
	let score = 0;
	const fU = FAIXAS["64444000"];
	const fC = FAIXAS["64504210"];

	// 1. Onda de montante via Uvaia (alto Tibagi descendo para a foz)
	if (
		(input.nUvaia != null && input.nUvaia >= fU.alertaCm) ||
		(input.deltaUvaia6h != null && input.deltaUvaia6h >= 30)
	) {
		score += 0.4;
		motivos.push(
			"Uvaia em alerta ou subindo ≥30 cm/6h (onda do alto Tibagi vindo para a foz)",
		);
	} else if (input.nUvaia != null && input.nUvaia >= fU.atencaoCm) {
		score += 0.2;
		motivos.push("Uvaia em atenção (alto Tibagi carregando)");
	}

	// 2. Corpo receptor (Cebolão) — quanto cabe ainda na calha da foz
	if (input.nCebolao != null && input.nCebolao >= fC.alertaCm) {
		score += 0.6;
		motivos.push(
			`Cebolão em alerta (${(input.nCebolao / 100).toFixed(2).replace(".", ",")} m ≥ P98) — calha quase sem folga`,
		);
	} else if (input.nCebolao != null && input.nCebolao >= fC.atencaoCm) {
		score += 0.4;
		motivos.push("Cebolão em atenção — capacidade de calha reduzida");
	}

	// 3. Enchimento próprio do Bitumirim (chuva local 6h)
	const ch = input.chuvaIpiranga6h ?? 0;
	if (ch >= 25) {
		score += 0.2;
		motivos.push(
			`${ch.toFixed(1).replace(".", ",")} mm/6h em Ipiranga — Bitumirim enchendo sozinho`,
		);
	} else if (ch >= 10) {
		score += 0.1;
		motivos.push(
			`${ch.toFixed(1).replace(".", ",")} mm/6h em Ipiranga — contribuição local relevante`,
		);
	}

	score = Math.round(score * 10) / 10;
	const nivel: NivelIBR =
		score >= 0.8
			? "vermelho"
			: score >= 0.5
				? "laranja"
				: score >= 0.3
					? "amarelo"
					: "verde";
	return { score, nivel, motivos };
}

export interface ResultadoIFL {
	score: number;
	nivel: NivelIBR;
	motivos: string[];
}

/**
 * Índice de Flash Local (IFL) — a outra perna da doutrina (auditoria
 * Antigravity). JAN25 provou que tromba local transborda o Bitumirim com o
 * Tibagi calmo: nenhum índice de remanso pega isso. IFL é 100% local
 * (CEMADEN 1h/6h/24h), desacoplado de qualquer régua do Tibagi.
 * Piso de 0,75 com 24h ≥ 90 mm = assinatura JAN25 (143 mm/dia).
 * Curto-circuito 1,0 com 1h ≥ 40 mm = chuva que não espera janela fechar.
 */
export function calcularIFL(input: {
	p1h: number | null;
	p6h: number | null;
	p24h: number | null;
}): ResultadoIFL {
	const motivos: string[] = [];
	const p1 = input.p1h ?? 0;
	const p6 = input.p6h ?? 0;
	const p24 = input.p24h ?? 0;
	let score = 0.5 * Math.min(p1 / 35, 1) + 0.5 * Math.min(p6 / 70, 1);
	if (p1 >= 1 || p6 >= 1 || p24 >= 1) {
		motivos.push(
			`${p1.toFixed(1).replace(".", ",")} mm/1h · ${p6.toFixed(1).replace(".", ",")} mm/6h · ${p24.toFixed(1).replace(".", ",")} mm/24h em Ipiranga`,
		);
	}
	if (p24 >= 90) {
		score = Math.max(score, 0.75);
		motivos.push(
			`acumulado de ${p24.toFixed(0).replace(".", ",")} mm/24h — assinatura de flash tipo JAN25`,
		);
	}
	if (p1 >= 40) {
		score = 1.0;
		motivos.push(
			`chuva extrema agora (${p1.toFixed(1).replace(".", ",")} mm/1h) — enxurrada imediata`,
		);
	}
	score = Math.round(score * 100) / 100;
	const nivel: NivelIBR =
		score >= 0.8
			? "vermelho"
			: score >= 0.5
				? "laranja"
				: score >= 0.3
					? "amarelo"
					: "verde";
	return { score, nivel, motivos };
}

/** Posição do nível atual contra as faixas. */
export function faixaNivel(
	codigo: string,
	nivelCm: number | null,
): "normal" | "atencao" | "alerta" | null {
	if (nivelCm == null) return null;
	const f = FAIXAS[codigo];
	if (!f) return null;
	if (nivelCm >= f.alertaCm) return "alerta";
	if (nivelCm >= f.atencaoCm) return "atencao";
	return "normal";
}

export interface HidroSeriePonto {
	dataHora: string; // "2026-08-26 20:00:00" (horário da ANA, BRT)
	nivelCm: number | null; // cm
	vazaoM3s: number | null;
	chuvaMm: number | null;
}

export interface HidroEstacao {
	codigo: string;
	nome: string;
	rio: string;
	municipio: string;
	papel: string;
	/** Leitura mais recente */
	nivelCm: number | null;
	vazaoM3s: number | null;
	chuvaMm: number | null;
	dataHora: string | null;
	/** Faixa calibrada do nível atual (P90/P98 de 180 dias) */
	faixa: "normal" | "atencao" | "alerta" | "critico" | null;
	/** Série das últimas ~24 h (horária) quando disponível */
	serie: HidroSeriePonto[];
	/** Δ nível nas últimas 6 h (cm), null se sem histórico suficiente */
	delta6hCm: number | null;
	erro?: string | null;
}

export interface HidroState {
	estacoes: HidroEstacao[];
	fonte: string;
	atualizadoEm: number | null;
	erro?: string | null;
	/** Avaliação rápida — usada no llms.txt e alertas */
	riscoEnxurrada: "ok" | "warn" | "critical";
	riscoCheia: "ok" | "watch" | "critical";
	/** IBR (Índice de Bloqueio por Remanso) — 4 estágios calibrados */
	ibr: ResultadoIBR | null;
	/** IFL (Índice de Flash Local) — 100% chuva local, sem Tibagi */
	ifl: ResultadoIFL | null;
	/** Texto curto para o llms.txt */
	resumoRisco: string;
}

function parseNum(v: string | null | undefined): number | null {
	if (v == null || v === "") return null;
	const n = Number(String(v).replace(",", "."));
	return Number.isFinite(n) ? n : null;
}

function parseXmlDados(xml: string): HidroSeriePonto[] {
	// Extrai cada <DadosHidrometereologicos> ... </DadosHidrometereologicos>
	const re =
		/<DadosHidrometereologicos[^>]*>([\s\S]*?)<\/DadosHidrometereologicos>/g;
	const pontos: HidroSeriePonto[] = [];
	let m: RegExpExecArray | null;
	while ((m = re.exec(xml))) {
		const block = m[1];
		const get = (tag: string) => {
			const r = new RegExp(`<${tag}>([^<]*)</${tag}>`);
			const mm = r.exec(block);
			return mm ? mm[1].trim() : null;
		};
		const dataHora = get("DataHora");
		if (!dataHora) continue;
		pontos.push({
			dataHora,
			nivelCm: parseNum(get("Nivel")),
			vazaoM3s: parseNum(get("Vazao")),
			chuvaMm: parseNum(get("Chuva")),
		});
	}
	// Ordena por dataHora desc (mais recente primeiro — API já vem assim)
	return pontos;
}

async function fetchEstacao(
	codigo: string,
	nome: string,
	rio: string,
	municipio: string,
	papel: string,
): Promise<HidroEstacao> {
	const hoje = new Date();
	const ontem = new Date(Date.now() - 24 * 3600 * 1000);
	const fmt = (d: Date) =>
		`${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
	const dataInicio = fmt(ontem);
	const dataFim = fmt(hoje);
	const url = `https://telemetriaws1.ana.gov.br/ServiceANA.asmx/DadosHidrometeorologicos?codEstacao=${codigo}&dataInicio=${dataInicio}&dataFim=${dataFim}`;

	try {
		const res = await fetch(url, {
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			headers: { Accept: "application/xml" },
		});
		if (!res.ok) {
			return {
				codigo,
				nome,
				rio,
				municipio,
				papel,
				nivelCm: null,
				vazaoM3s: null,
				chuvaMm: null,
				dataHora: null,
				faixa: null,
				serie: [],
				delta6hCm: null,
				erro: `HTTP ${res.status}`,
			};
		}
		const xml = await res.text();
		if (xml.includes("<ErrorTable") || xml.includes("Sem dados")) {
			return {
				codigo,
				nome,
				rio,
				municipio,
				papel,
				nivelCm: null,
				vazaoM3s: null,
				chuvaMm: null,
				dataHora: null,
				faixa: null,
				serie: [],
				delta6hCm: null,
				erro: "Sem dados no período",
			};
		}
		const serie = parseXmlDados(xml);
		// Saneia lixo de sensor: 777777.7 = código de falha da telemetria
		// (visto em 250 pontos de 180 dias em Antas). Ponto absurdo não pode
		// virar "leitura atual" nem contaminar o Δ6h.
		const sanea = (p: HidroSeriePonto): HidroSeriePonto => ({
			...p,
			nivelCm:
				p.nivelCm != null && p.nivelCm > 0 && p.nivelCm < 2000
					? p.nivelCm
					: null,
			vazaoM3s:
				p.vazaoM3s != null && p.vazaoM3s >= 0 && p.vazaoM3s < 20000
					? p.vazaoM3s
					: null,
		});
		const serieLimpa = serie.map(sanea);
		if (serieLimpa.length === 0) {
			return {
				codigo,
				nome,
				rio,
				municipio,
				papel,
				nivelCm: null,
				vazaoM3s: null,
				chuvaMm: null,
				dataHora: null,
				faixa: null,
				serie: [],
				delta6hCm: null,
				erro: "Série vazia",
			};
		}
		let latestIdx = serieLimpa.findIndex((p) => p.nivelCm != null);
		if (latestIdx < 0) latestIdx = 0;
		const latest = serieLimpa[latestIdx];
		// Δ 6 h: compara com o ponto ~6 posições atrás do mais recente válido
		let delta6hCm: number | null = null;
		if (latest.nivelCm != null) {
			let idx = latestIdx + 6;
			while (idx < serieLimpa.length && serieLimpa[idx].nivelCm == null) idx++;
			if (idx < serieLimpa.length && serieLimpa[idx].nivelCm != null) {
				delta6hCm = latest.nivelCm - (serieLimpa[idx].nivelCm as number);
			}
		}
		return {
			codigo,
			nome,
			rio,
			municipio,
			papel,
			nivelCm: latest.nivelCm,
			vazaoM3s: latest.vazaoM3s,
			chuvaMm: latest.chuvaMm,
			dataHora: latest.dataHora,
			faixa: faixaEstendida(codigo, latest.nivelCm),
			serie: serieLimpa.slice(0, 24),
			delta6hCm,
			erro: null,
		};
	} catch (e: unknown) {
		const msg = e instanceof Error ? e.message : String(e);
		return {
			codigo,
			nome,
			rio,
			municipio,
			papel,
			nivelCm: null,
			vazaoM3s: null,
			chuvaMm: null,
			dataHora: null,
			faixa: null,
			serie: [],
			delta6hCm: null,
			erro: msg,
		};
	}
}

/** Chuva local (CEMADEN, máx entre as estações) para o IFL e o remanso. */
export interface ChuvaLocal {
	p1h: number | null;
	p6h: number | null;
	p24h: number | null;
}

/** Exportada para testes (lógica de faixas/remanso/flash). */
export function avaliarRisco(
	estacoes: HidroEstacao[],
	chuva: ChuvaLocal | null,
): Pick<HidroState, "riscoEnxurrada" | "riscoCheia" | "resumoRisco" | "ibr" | "ifl"> {
	// Triangulação é referência regional (Ipiranga NÃO tem estação
	// fluviométrica própria — o Bitumirim não é medido direto). Por isso a
	// classificação automática é CONSERVADORA: só sobe para "watch" com
	// evidência convergente (rio subindo + chuva medida aqui e na sentinela).
	// "critical" nunca é gerado aqui — cheia se confirma pela Defesa Civil/IAT.
	const comDados = estacoes.filter((e) => !e.erro && e.nivelCm != null);
	if (comDados.length === 0) {
		return {
			riscoEnxurrada: "ok",
			riscoCheia: "ok",
			ibr: null,
			ifl: null,
			resumoRisco:
				"Triangulação indisponível no momento (sentinelas sem dados). Ipiranga não possui estação fluviométrica própria — para alertas oficiais, siga Defesa Civil e IAT.",
		};
	}
	const fmtDelta = (d: number | null) =>
		d == null
			? "sem histórico 6h"
			: `${d > 0 ? "subindo" : d < 0 ? "descendo" : "estável"} (${d > 0 ? "+" : ""}${(d / 100).toFixed(2).replace(".", ",")} m/6h)`;
	const trechos = comDados.map((e) => {
		const nomeCurto = e.nome.split(" (")[0];
		const fx = faixaNivel(e.codigo, e.nivelCm);
		const fxTxt =
			fx === "alerta"
				? " (faixa ALERTA)"
				: fx === "atencao"
					? " (faixa atenção)"
					: "";
		const chuva =
			e.chuvaMm != null
				? `, chuva ${e.chuvaMm.toFixed(1).replace(".", ",")} mm/h no local`
				: "";
		return `${nomeCurto}: ${((e.nivelCm as number) / 100).toFixed(2).replace(".", ",")} m${fxTxt} (${fmtDelta(e.delta6hCm)}${chuva})`;
	});
	const subindoForte = comDados.some((e) => (e.delta6hCm ?? 0) >= 30);
	const chuvaSentinela = Math.max(0, ...comDados.map((e) => e.chuvaMm ?? 0));
	const chuvaLocal = chuva?.p6h ?? 0;
	const porCodigo = (cod: string) => comDados.find((e) => e.codigo === cod);
	const uvaia = porCodigo("64444000");
	const cebolao = porCodigo("64504210");
	const faixaCebolao = faixaNivel("64504210", cebolao?.nivelCm ?? null);
	const algumaEmAlerta = comDados.some(
		(e) => faixaNivel(e.codigo, e.nivelCm) === "alerta",
	);
	// REMANSO: Tibagi cheio a montante/foz + chuva em Ipiranga = o Bitumirim
	// pode não conseguir desaguar. Estimativa (sem medição na foz).
	const remanso =
		(faixaCebolao === "atencao" || faixaCebolao === "alerta") &&
		chuvaLocal >= 10;
	// Watch individual: faixa de alerta, subida forte, remanso ou convergência.
	const watch =
		algumaEmAlerta ||
		subindoForte ||
		remanso ||
		(chuvaLocal >= 15 && chuvaSentinela >= 10);
	const motivos: string[] = [];
	if (algumaEmAlerta)
		motivos.push("nível na faixa de alerta (P98 do ano hidrológico)");
	if (subindoForte)
		motivos.push("nível subindo ≥30 cm em 6h em ao menos uma sentinela");
	if (remanso)
		motivos.push(
			`Tibagi cheio (Cebolão ${cebolao?.nivelCm != null ? (cebolao.nivelCm / 100).toFixed(2).replace(".", ",") : "?"} m) + ${chuvaLocal.toFixed(1).replace(".", ",")} mm/6h em Ipiranga: o Bitumirim pode não conseguir desaguar (remanso) — atenção a alagamentos em áreas baixas`,
		);
	if (chuvaLocal >= 15 && chuvaSentinela >= 10)
		motivos.push(
			`chuva convergente (${chuvaLocal.toFixed(1).replace(".", ",")} mm/6h em Ipiranga + ${chuvaSentinela.toFixed(1).replace(".", ",")} mm/h na sentinela)`,
		);
	// IBR (remanso, montante) + IFL (flash, 100% local) — doutrina 2 pernas.
	const ibr = calcularIBR({
		nUvaia: uvaia?.nivelCm ?? null,
		deltaUvaia6h: uvaia?.delta6hCm ?? null,
		nCebolao: cebolao?.nivelCm ?? null,
		chuvaIpiranga6h: chuva?.p6h ?? null,
	});
	const ifl = calcularIFL({
		p1h: chuva?.p1h ?? null,
		p6h: chuva?.p6h ?? null,
		p24h: chuva?.p24h ?? null,
	});
	if (ifl.nivel !== "verde") {
		motivos.push(`flash local IFL ${ifl.score.toFixed(2).replace(".", ",")} (${ifl.nivel}): ${ifl.motivos.join("; ")}`);
	}
	const watchFinal =
		watch || ibr.nivel === "laranja" || ibr.nivel === "vermelho" || ifl.nivel === "laranja" || ifl.nivel === "vermelho";
	return {
		riscoEnxurrada: watchFinal ? "warn" : "ok",
		riscoCheia: watchFinal ? "watch" : "ok",
		ibr,
		ifl,
		resumoRisco:
			`Triangulação no Rio Tibagi (referência regional — o Bitumirim em Ipiranga não é medido direto; faixas P90/P98 do ano hidrológico). ` +
			`${trechos.join(" · ")}.` +
			` IBR ${ibr.score.toFixed(1).replace(".", ",")} (${ibr.nivel}) · IFL ${ifl.score.toFixed(2).replace(".", ",")} (${ifl.nivel}).` +
			(motivos.length > 0
				? ` Atenção: ${motivos.join("; ")} — acompanhe Defesa Civil/IAT.`
				: " Níveis sem tendência de cheia no momento.") +
			` Para alertas oficiais, siga Defesa Civil e IAT.`,
	};
}

/** Busca as 3 sentinelas ANA em paralelo (usado no cron). */
export async function fetchHidroTriangulacao(
	chuva: ChuvaLocal | null = null,
): Promise<HidroState> {
	try {
		const resultados = await Promise.all(
			SENTINELAS.map((s) =>
				fetchEstacao(s.codigo, s.nome, s.rio, s.municipio, s.papel),
			),
		);

		// Se todas falharam, degrada sem quebrar o ciclo de clima
		const comDados = resultados.filter((r) => !r.erro);
		const erro =
			comDados.length === 0
				? resultados.map((r) => r.erro).join(" | ") || "falha"
				: null;

		const risco = avaliarRisco(resultados, chuva);

		return {
			estacoes: resultados,
			fonte: "ANA Hidro (telemetria)",
			atualizadoEm: Date.now(),
			erro,
			...risco,
		};
	} catch (e: unknown) {
		const msg = e instanceof Error ? e.message : String(e);
		return {
			estacoes: [],
			fonte: "ANA Hidro (telemetria)",
			atualizadoEm: null,
			erro: msg,
			riscoEnxurrada: "ok",
			riscoCheia: "ok",
			ibr: null,
			ifl: null,
			resumoRisco: "Dados hidro temporariamente indisponíveis.",
		};
	}
}
