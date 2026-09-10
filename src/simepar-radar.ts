import { logger } from "./logger.js";

/**
 * Mosaico de radares do SIMEPAR (display, não detecção).
 *
 * O que é: JPEG 980x672 com mapa + timestamp + legenda embutidos, 8 frames
 * (product1 = mais recente, product8 = ~70 min atrás, passo ~10 min).
 * Alcance declarado 480 km (radar de Cascavel).
 *
 * Limitação conhecida (10/09/2026, avisada no próprio site do Simepar): o
 * radar de Teixeira Soares está DESATIVADO por falha crítica — o mosaico
 * atual é só Cascavel, a ~400 km de Ipiranga (feixe alto, resolução grossa
 * aqui). Quando Teixeira voltar, este mesmo endpoint passa a incluir ele
 * sem mudar nada no nosso código.
 *
 * Por que display e não detecção: a imagem vem "assada" (mapa base + rótulos
 * + radar no mesmo JPEG) — classificar pixel aqui exigiria georreferenciar
 * a imagem e mascarar o mapa. A detecção continua no RainViewer (tiles crus
 * georreferenciados); o mosaico dá ao cidadão o contexto visual oficial.
 */

export const SIMEPAR_MOSAIC_URL =
	"https://lb01.simepar.br/riak/pgw-radar/product1.jpeg";
export const SIMEPAR_PAGINA = "http://stage.simepar.br/simepar/radar_msc";

export interface SimeparRadarState {
	imageUrl: string;
	paginaFonte: string;
	atualizadoEm: number | null;
	disponivel: boolean;
	/** Radar de Teixeira Soares (o perto de Ipiranga) fora do ar */
	teixeiraSoaresOffline: boolean;
	aviso: string;
	erro?: string | null;
}

/** HEAD no JPEG atual (barato) para extrair o Last-Modified. Nunca lança. */
export async function fetchSimeparRadar(): Promise<SimeparRadarState> {
	const base: SimeparRadarState = {
		imageUrl: SIMEPAR_MOSAIC_URL,
		paginaFonte: SIMEPAR_PAGINA,
		atualizadoEm: null,
		disponivel: false,
		teixeiraSoaresOffline: true,
		aviso:
			"Radar de Teixeira Soares temporariamente desativado (falha crítica, aviso do próprio Simepar) — mosaico atual é só o radar de Cascavel (~400 km de Ipiranga).",
		erro: null,
	};
	try {
		const res = await fetch(SIMEPAR_MOSAIC_URL, {
			method: "HEAD",
			signal: AbortSignal.timeout(8_000),
			headers: {
				"User-Agent":
					"ServicosIpirangaStatus/1.0 (+https://servicos-status.vercel.app)",
			},
		});
		if (!res.ok) return { ...base, erro: `HTTP ${res.status}` };
		const lm = res.headers.get("last-modified");
		const ts = lm ? Date.parse(lm) : NaN;
		return {
			...base,
			disponivel: true,
			atualizadoEm: Number.isFinite(ts) ? ts : Date.now(),
		};
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		logger.warn("Simepar radar HEAD falhou", { error: msg });
		return { ...base, erro: msg };
	}
}
