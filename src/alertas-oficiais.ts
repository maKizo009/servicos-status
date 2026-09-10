import { logger } from "./logger.js";

/**
 * Alertas oficiais + alerta unificado próprio do Monitor Ipiranga.
 *
 * Fontes oficiais tentadas (todas com timeout curto, nunca lançam):
 *  - INMET alertas2 (https://alertas2.inmet.gov.br) — avisos com área por
 *    município (filtramos Ipiranga/PR, IBGE 4110508).
 *  - Defesa Civil PR (galeria de avisos SIMEPAR).
 *  - SIMEPAR prognozweb (previsão por município).
 *
 * Como essas fontes vivem atrás de Cloudflare/captcha e podem falhar do
 * serverless, o ALERTA UNIFICADO nunca depende delas: ele é calculado de
 * forma determinística a partir dos NOSSOS dados (CEMADEN + ECMWF + radar
 * + hidro) e usa os oficiais como AGRAVANTE (sobe o nível, nunca desce
 * sozinho sem dado local — exceto aviso vermelho oficial, que sobe por
 * segurança).
 */

export type NivelAlerta = "verde" | "amarelo" | "laranja" | "vermelho";

export interface AvisoOficial {
	fonte: "INMET" | "SIMEPAR" | "Defesa Civil PR";
	titulo: string;
	nivel: NivelAlerta;
	areas?: string;
	inicio?: string;
	fim?: string;
	link?: string;
}

export interface AlertasOficiaisState {
	avisos: AvisoOficial[];
	erros: string[];
	atualizadoEm: number | null;
}

export interface AlertaUnificado {
	nivel: NivelAlerta;
	titulo: string;
	descricao: string;
	/** O que pesou na decisão (observável, sem caixa-preta) */
	motivos: string[];
	avisosOficiais: AvisoOficial[];
	atualizadoEm: number;
}

const FETCH_TIMEOUT_MS = 8_000;
const COD_IBGE_IPIRANGA = "4110508";

async function fetchText(url: string): Promise<string | null> {
	try {
		const res = await fetch(url, {
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
			headers: {
				"User-Agent":
					"ServicosIpirangaStatus/1.0 (+https://servicos-status.vercel.app)",
				Accept: "text/html,application/json",
			},
		});
		if (!res.ok) return null;
		return await res.text();
	} catch {
		return null;
	}
}

function nivelCorInmet(cor: string): NivelAlerta {
	const c = cor.toLowerCase();
	if (c.includes("vermelh") || c.includes("red") || c.includes("grande perigo"))
		return "vermelho";
	if (c.includes("laranja") || c.includes("orange") || c.includes("perigo"))
		return "laranja";
	if (c.includes("amarelo") || c.includes("yellow") || c.includes("potencial"))
		return "amarelo";
	return "verde";
}

/** INMET alertas2: tenta o endpoint JSON; filtra avisos que citam Ipiranga/PR. */
async function fetchInmet(): Promise<{
	avisos: AvisoOficial[];
	erro?: string;
}> {
	const candidatos = [
		"https://alertas2.inmet.gov.br/api/alertas",
		"https://alertas2.inmet.gov.br/api/alertas/ativos",
	];
	for (const url of candidatos) {
		const txt = await fetchText(url);
		if (!txt || txt.length < 50) continue;
		try {
			const json = JSON.parse(txt) as unknown;
			const lista: unknown[] = Array.isArray(json)
				? json
				: Array.isArray((json as Record<string, unknown>)?.alertas)
					? ((json as Record<string, unknown>).alertas as unknown[])
					: [];
			const avisos: AvisoOficial[] = [];
			for (const a of lista) {
				const r = a as Record<string, unknown>;
				const blob = JSON.stringify(r);
				const citaIpiranga =
					blob.includes(COD_IBGE_IPIRANGA) ||
					/IPIRANGA/i.test(blob) ||
					/Campos Gerais/i.test(blob) ||
					/PARAN[AÁ]/i.test(blob);
				if (!citaIpiranga) continue;
				const titulo =
					(typeof r.titulo === "string" && r.titulo) ||
					(typeof r.evento === "string" && r.evento) ||
					(typeof r.description === "string" &&
						(r.description as string).slice(0, 120)) ||
					"Aviso INMET para a região";
				avisos.push({
					fonte: "INMET",
					titulo: titulo.slice(0, 200),
					nivel: nivelCorInmet(
						`${r.severidade ?? ""} ${r.nivel ?? ""} ${r.cor ?? ""} ${r.headline ?? ""}`,
					),
					areas:
						typeof r.areas === "string" ? r.areas.slice(0, 200) : undefined,
					link: "https://alertas2.inmet.gov.br/",
				});
			}
			return { avisos };
		} catch {}
	}
	return { avisos: [], erro: "INMET alertas2 indisponível (timeout/bloqueio)" };
}

/** Defesa Civil PR: extrai menções de aviso meteorológico vigente da página. */
async function fetchDefesaCivil(): Promise<{
	avisos: AvisoOficial[];
	erro?: string;
}> {
	const txt = await fetchText(
		"https://www.defesacivil.pr.gov.br/Galeria-de-Imagens/Aviso-meteorologico-SIMEPAR",
	);
	if (!txt) return { avisos: [], erro: "Defesa Civil PR indisponível" };
	// Procura blocos de aviso com data recente no HTML (sem parser pesado).
	const achados: AvisoOficial[] = [];
	const re =
		/aviso[^<]{0,200}(temporal|chuva|vendaval|granizo|geada|enchente|alagamento|deslizamento)[^<]{0,200}/gi;
	let m: RegExpExecArray | null;
	for (;;) {
		m = re.exec(txt);
		if (!m || achados.length >= 3) break;
		const titulo = m[0]
			.replace(/<[^>]+>/g, "")
			.replace(/\s+/g, " ")
			.trim()
			.slice(0, 200);
		if (titulo.length > 20) {
			achados.push({
				fonte: "Defesa Civil PR",
				titulo,
				nivel: /temporal|vendaval|granizo|enchente/i.test(titulo)
					? "laranja"
					: "amarelo",
				link: "https://www.defesacivil.pr.gov.br/Galeria-de-Imagens/Aviso-meteorologico-SIMEPAR",
			});
		}
	}
	return { avisos: achados };
}

/** Busca as fontes oficiais em paralelo (usado no cron). Nunca lança. */
export async function fetchAlertasOficiais(): Promise<AlertasOficiaisState> {
	try {
		const [inmet, dc] = await Promise.all([fetchInmet(), fetchDefesaCivil()]);
		const avisos = [...inmet.avisos, ...dc.avisos];
		const erros: string[] = [];
		if (inmet.erro) erros.push(inmet.erro);
		if (dc.erro) erros.push(dc.erro);
		return { avisos, erros, atualizadoEm: Date.now() };
	} catch (e) {
		return {
			avisos: [],
			erros: [e instanceof Error ? e.message : String(e)],
			atualizadoEm: null,
		};
	}
}

export interface DadosLocaisAlerta {
	acc1hrMax: number | null;
	acc6hrMax: number | null;
	acc24hrMax: number | null;
	ecmwfPct: number | null;
	ecmwfProx6hMm: number | null;
	radarAlertLevel: "alert" | "watch" | "monitor" | "none";
	hidroWatch: boolean;
}

/**
 * Nosso próprio alerta: fusão determinística dos dados locais + oficiais.
 * Oficiais AGRAVAM (sobem o nível); só o vermelho oficial sobe sozinho.
 */
export function buildAlertaUnificado(
	local: DadosLocaisAlerta,
	oficiais: AlertasOficiaisState | null,
): AlertaUnificado {
	const motivos: string[] = [];
	let nivel: NivelAlerta = "verde";

	const c1 = local.acc1hrMax ?? 0;
	const c6 = local.acc6hrMax ?? 0;
	const c24 = local.acc24hrMax ?? 0;
	const pct = local.ecmwfPct ?? 0;

	// --- Base: o que está MEDIDO aqui ---
	if (c1 >= 20 || c6 >= 50) {
		nivel = "vermelho";
		motivos.push(
			`chuva forte medida em Ipiranga (${c1.toFixed(1).replace(".", ",")} mm/1h, ${c6.toFixed(1).replace(".", ",")} mm/6h)`,
		);
	} else if (c6 >= 25 || c24 >= 50 || local.radarAlertLevel === "alert") {
		nivel = "laranja";
		if (local.radarAlertLevel === "alert")
			motivos.push("núcleo de chuva iminente no radar (≤80 km)");
		if (c6 >= 25)
			motivos.push(
				`${c6.toFixed(1).replace(".", ",")} mm em 6h nos pluviômetros`,
			);
		if (c24 >= 50)
			motivos.push(
				`${c24.toFixed(1).replace(".", ",")} mm em 24h nos pluviômetros`,
			);
	} else if (
		local.radarAlertLevel === "watch" ||
		c24 >= 20 ||
		c6 >= 10 ||
		pct >= 70 ||
		(local.ecmwfProx6hMm ?? 0) >= 5 ||
		local.hidroWatch
	) {
		nivel = "amarelo";
		if (local.radarAlertLevel === "watch")
			motivos.push("núcleo de chuva em vigilância no radar");
		if (c24 >= 20)
			motivos.push(
				`${c24.toFixed(1).replace(".", ",")} mm em 24h nos pluviômetros`,
			);
		if (pct >= 70) motivos.push(`ECMWF indica ${Math.round(pct)}% de chuva`);
		if (local.hidroWatch)
			motivos.push("nível dos rios em atenção (triangulação ANA)");
	}

	// --- Agravante oficial ---
	const avisos = oficiais?.avisos ?? [];
	const maxOficial: NivelAlerta = avisos.reduce<NivelAlerta>(
		(acc, a) => (ordem(a.nivel) > ordem(acc) ? a.nivel : acc),
		"verde",
	);
	if (maxOficial === "vermelho") {
		if (nivel !== "vermelho")
			motivos.push("aviso VERMELHO oficial (INMET/Defesa Civil) para a região");
		nivel = "vermelho";
	} else if (ordem(maxOficial) > ordem(nivel) && nivel !== "verde") {
		motivos.push(
			`aviso ${maxOficial} oficial (${avisos[0]?.fonte}) para a região`,
		);
		nivel = maxOficial;
	} else if (maxOficial !== "verde" && nivel === "verde") {
		// Oficial sozinho (sem chuva local) vira amarelo de atenção, não pânico.
		motivos.push(
			`aviso ${maxOficial} oficial (${avisos[0]?.fonte}) — sem chuva medida em Ipiranga no momento`,
		);
		nivel = "amarelo";
	}

	const titulo =
		nivel === "vermelho"
			? "Alerta vermelho — risco alto de chuva forte em Ipiranga"
			: nivel === "laranja"
				? "Alerta laranja — chuva forte em Ipiranga/região"
				: nivel === "amarelo"
					? "Atenção — chuva em Ipiranga/região"
					: "Tempo sem alertas em Ipiranga";

	const descricao =
		motivos.length > 0
			? `${titulo}. Motivos: ${motivos.join("; ")}.`
			: "Sem chuva relevante medida nem avisos oficiais para Ipiranga no momento.";

	return {
		nivel,
		titulo,
		descricao,
		motivos,
		avisosOficiais: avisos,
		atualizadoEm: Date.now(),
	};
}

function ordem(n: NivelAlerta): number {
	return n === "verde" ? 0 : n === "amarelo" ? 1 : n === "laranja" ? 2 : 3;
}

export function logAlertaUnificado(a: AlertaUnificado): void {
	logger.info("Alerta unificado calculado", {
		nivel: a.nivel,
		motivos: a.motivos,
		avisos: a.avisosOficiais.length,
	});
}
