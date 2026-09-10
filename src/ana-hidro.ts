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

// 3 sentinelas na calha do Tibagi — cercam Ipiranga a ~30-80 km.
// Código ANA, nome humano e papel na triangulação.
export const SENTINELAS = [
	{
		codigo: "64491000",
		nome: "Ribeirão das Antas (UHE Gov. Jayme Canet Junior jusante)",
		rio: "Tibagi",
		papel: "Montante — influência de vazão liberada (efeito Mauá)",
		municipio: "Telêmaco Borba",
	},
	{
		codigo: "64504210",
		nome: "Cebolão",
		rio: "Tibagi",
		papel: "Central — nível do Tibagi na região de Ponta Grossa/Castro",
		municipio: "Castro",
	},
	{
		codigo: "64507000",
		nome: "Jataizinho (UHE Capivara)",
		rio: "Tibagi",
		papel: "Jusante — velocidade de escoamento após Ipiranga",
		municipio: "Jataizinho",
	},
] as const;

/**
 * Faixas de referência por sentinela (10/09/2026) — CALIBRADAS com 180 dias
 * reais de telemetria ANA (14/03–10/09/2026), não chutadas:
 * atenção = P90, alerta = P98 da série horária (filtrado lixo de sensor:
 * nível 777777.7 = código de falha, descartado).
 *
 * - 64491000 Antas: nível P90 398 / P98 472 (máx 619); vazão P98 824
 * - 64504210 Cebolão: nível P90 346 / P98 369 (máx 419); vazão P98 1172
 * - 64507000 Jataizinho: nível P90 271 / P98 304 (máx 381); vazão P98 971
 *
 * São faixas RELATIVAS (percentil), não cotas oficiais de inundação — a ANA
 * não publica cota de cheia para estas estações. Recalibrar trimestralmente
 * (script /tmp/cotas.py + série longa do DadosHidrometeorologicos).
 */
export const FAIXAS: Record<
	string,
	{ atencaoCm: number; alertaCm: number; vazaoP98: number }
> = {
	"64491000": { atencaoCm: 398, alertaCm: 472, vazaoP98: 824 },
	"64504210": { atencaoCm: 346, alertaCm: 369, vazaoP98: 1172 },
	"64507000": { atencaoCm: 271, alertaCm: 304, vazaoP98: 971 },
};

/**
 * Tetos históricos — picos medidos nos 3 eventos de referência:
 * - OUT23 (enchente histórica, fim out/início nov 2023): chuva 323 mm/4d em
 *   São Braz + 257 mm em Suruvi + 90 mm em Castro; Antas 903 cm/2683 m³/s,
 *   Cebolão 517 cm, Jataizinho 534 cm/3061 m³/s.
 * - DEZ24 (cheia regional, 07-09/12/2024): 149+128 mm em São Braz,
 *   106+99 mm em Suruvi; Antas 622 cm/1366 m³/s, Cebolão 391 cm,
 *   Jataizinho 366 cm/1430 m³/s (pico com ~3 dias de atraso da chuva).
 * - JAN25 (flash local, 19/01/2025): 143 mm/dia em São Braz (19 mm em Suruvi
 *   a 11 km — tromba hiper-localizada); Tibagi CALMO (Antas 378, Cebolão 325,
 *   Jataizinho 256, todos abaixo do P90). Prova: sentinela não vê flash local.
 */
export const TETOS_HISTORICOS = {
	out23: {
		antasCm: 903,
		cebolaoCm: 517,
		jataizinhoCm: 534,
		chuvaSpBrazMm: 323,
	},
	dez24: {
		antasCm: 622,
		cebolaoCm: 391,
		jataizinhoCm: 366,
		chuvaSpBrazMm: 298,
	},
	jan25: {
		antasCm: 378,
		cebolaoCm: 325,
		jataizinhoCm: 256,
		chuvaSpBrazMm: 143,
	},
} as const;

/** Nível crítico = teto DEZ24 (cheia regional recente, abaixo da histórica). */
export const NIVEL_CRITICO: Record<string, number> = {
	"64491000": TETOS_HISTORICOS.dez24.antasCm,
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
 * Índice de Bloqueio por Remanso (IBR) — estrutura proposta pelo Gemini,
 * números NOSSOS (faixas P90/P98 calibradas + tetos OUT23/DEZ24/JAN25).
 * Pesos: descarga/antenas 0.4 + corpo receptor 0.4/0.6 + chuva local 0.2.
 * Estágios: <0.3 verde · 0.3–0.5 amarelo · 0.5–0.8 laranja · ≥0.8 vermelho.
 */
export function calcularIBR(input: {
	nAntas: number | null;
	deltaAntas6h: number | null;
	vazaoAntas: number | null;
	chuvaAntas: number | null;
	nCebolao: number | null;
	chuvaIpiranga6h: number | null;
}): ResultadoIBR {
	const motivos: string[] = [];
	let score = 0;
	const fA = FAIXAS["64491000"];
	const fC = FAIXAS["64504210"];

	// 1. Cabeça da onda / descarga Mauá via Antas
	if (
		(input.nAntas != null && input.nAntas >= fA.alertaCm) ||
		(input.deltaAntas6h != null && input.deltaAntas6h >= 30)
	) {
		score += 0.4;
		motivos.push(
			"Antas em alerta ou subindo ≥30 cm/6h (cabeça da onda/descarga Mauá)",
		);
	} else if (input.nAntas != null && input.nAntas >= fA.atencaoCm) {
		score += 0.2;
		motivos.push("Antas em atenção (montante carregando)");
	}
	// Descarga confirmada por vazão: Antas ≥P98 de vazão SEM chuva local =
	// água do reservatório, não da chuva (assinatura da UHE liberando).
	if (
		input.vazaoAntas != null &&
		input.vazaoAntas >= fA.vazaoP98 &&
		(input.chuvaAntas ?? 0) < 10
	) {
		score += 0.2;
		motivos.push(
			`descarga Mauá por vazão (${Math.round(input.vazaoAntas)} m³/s ≥ P98 sem chuva local)`,
		);
	}

	// 2. Corpo receptor (Cebolão) — quanto cabe ainda no Tibagi médio
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
			serie: [],
			delta6hCm: null,
			erro: msg,
		};
	}
}

/** Exportada para testes (lógica de faixas/remanso/descarga). */
export function avaliarRisco(
	estacoes: HidroEstacao[],
	cemadenAcc6hMax: number | null,
): Pick<HidroState, "riscoEnxurrada" | "riscoCheia" | "resumoRisco" | "ibr"> {
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
	const chuvaLocal = cemadenAcc6hMax ?? 0;
	const porCodigo = (cod: string) => comDados.find((e) => e.codigo === cod);
	const cebolao = porCodigo("64504210");
	const antas = porCodigo("64491000");
	const faixaCebolao = faixaNivel("64504210", cebolao?.nivelCm ?? null);
	const algumaEmAlerta = comDados.some(
		(e) => faixaNivel(e.codigo, e.nivelCm) === "alerta",
	);
	// DESCARGA (efeito Mauá a montante): Antas é jusante da UHE — vazão ≥P98
	// com chuva fraca na sentinela = água LIBERADA pelo reservatório, não chuva.
	const descargaMaua =
		antas?.vazaoM3s != null &&
		antas.vazaoM3s >= (FAIXAS["64491000"]?.vazaoP98 ?? 824) &&
		(antas.chuvaMm ?? 0) < 10;
	// REMANSO (efeito Mauá a jusante): Tibagi cheio no trecho central +
	// chuva em Ipiranga = o Bitumirim não consegue desaguar (o Tibagi "segura").
	// É estimativa (sem medição na foz), dita como tal.
	const remanso =
		(faixaCebolao === "atencao" || faixaCebolao === "alerta") &&
		chuvaLocal >= 10;
	// Watch: faixa de alerta em qualquer sentinela, subida forte, descarga,
	// remanso, ou chuva forte convergente (aqui + lá).
	const watch =
		algumaEmAlerta ||
		subindoForte ||
		descargaMaua ||
		remanso ||
		(chuvaLocal >= 15 && chuvaSentinela >= 10);
	const motivos: string[] = [];
	if (algumaEmAlerta)
		motivos.push("nível na faixa de alerta (P98 de 180 dias)");
	if (subindoForte)
		motivos.push("nível subindo ≥30 cm em 6h em ao menos uma sentinela");
	if (descargaMaua)
		motivos.push(
			`UHE Mauá liberando acima do normal (Antas com ${Math.round(antas?.vazaoM3s ?? 0)} m³/s ≥ P98, sem chuva local forte) — onda a caminho do trecho médio`,
		);
	if (remanso)
		motivos.push(
			`Tibagi cheio no trecho central (Cebolão ${cebolao?.nivelCm != null ? (cebolao.nivelCm / 100).toFixed(2).replace(".", ",") : "?"} m) + ${chuvaLocal.toFixed(1).replace(".", ",")} mm/6h em Ipiranga: o Bitumirim pode não conseguir desaguar (remanso) — atenção a alagamentos em áreas baixas`,
		);
	if (chuvaLocal >= 15 && chuvaSentinela >= 10)
		motivos.push(
			`chuva convergente (${chuvaLocal.toFixed(1).replace(".", ",")} mm/6h em Ipiranga + ${chuvaSentinela.toFixed(1).replace(".", ",")} mm/h na sentinela)`,
		);
	// IBR (Índice de Bloqueio por Remanso): score ponderado 0–1.2 com os
	// mesmos ingredientes acima, em 4 estágios calibrados nos eventos
	// OUT23/DEZ24/JAN25. O watch continua valendo pelas regras individuais;
	// o IBR dá o estágio único pro card e pro llms.txt.
	const ibr = calcularIBR({
		nAntas: antas?.nivelCm ?? null,
		deltaAntas6h: antas?.delta6hCm ?? null,
		vazaoAntas: antas?.vazaoM3s ?? null,
		chuvaAntas: antas?.chuvaMm ?? null,
		nCebolao: cebolao?.nivelCm ?? null,
		chuvaIpiranga6h: cemadenAcc6hMax,
	});
	const watchFinal =
		watch || ibr.nivel === "laranja" || ibr.nivel === "vermelho";
	return {
		riscoEnxurrada: watchFinal ? "warn" : "ok",
		riscoCheia: watchFinal ? "watch" : "ok",
		ibr,
		resumoRisco:
			`Triangulação no Rio Tibagi (referência regional — o Bitumirim em Ipiranga não é medido direto; faixas calibradas com 180 dias reais: atenção=P90, alerta=P98). ` +
			`${trechos.join(" · ")}.` +
			` IBR ${ibr.score.toFixed(1).replace(".", ",")} (${ibr.nivel}).` +
			(motivos.length > 0
				? ` Atenção: ${motivos.join("; ")} — acompanhe Defesa Civil/IAT.`
				: " Níveis sem tendência de cheia no momento.") +
			` Para alertas oficiais, siga Defesa Civil e IAT.`,
	};
}

/** Busca as 3 sentinelas ANA em paralelo (usado no cron). */
export async function fetchHidroTriangulacao(
	cemadenAcc6hMax: number | null = null,
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

		const risco = avaliarRisco(resultados, cemadenAcc6hMax);

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
			resumoRisco: "Dados hidro temporariamente indisponíveis.",
		};
	}
}
