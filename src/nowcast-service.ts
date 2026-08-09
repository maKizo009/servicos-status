import { logger } from "./logger.js";
import { analyzeRadarNowcast, type NowcastResult } from "./radar-analysis.js";
import {
	fetchRainViewerRadar,
	getCachedWeatherState,
} from "./weather-collector.js";

/**
 * Serviço de nowcast (Camada A determinística) com cache em memória.
 *
 * Reaproveita o radar já sincronizado no WeatherState (frames past do
 * RainViewer) para evitar refetch do JSON; calcula a análise de núcleos
 * e movimento apenas quando o cache expira (TTL 5 min).
 */

const TTL_MS = 5 * 60_000;

/**
 * Grid 4x4 de tiles z=7 (44-47 × 72-75) centrado em Ipiranga.
 *
 * Ipiranga fica na borda OESTE do tile 46/73 — um tile único não enxerga
 * núcleos vindo de oeste/norte (caso real 2026-08-09: núcleo de 53 dBZ no
 * tile 45/73 invisível para o nowcast). O grid 4x4 cobre lon -53.4..-47.8
 * e lat -22..-29: captura células vindo de qualquer quadrante.
 *
 * gridSize=4 (potência de 2) é obrigatório para a conversão px→lat/lon do
 * normalizeRegion/pixelToLatLon (parent z=5). Grid 3x3 quebraria a conta.
 */
export const REGION_GRID = {
	z: 7,
	xMin: 44,
	yMin: 72,
	xMax: 47,
	yMax: 75,
} as const;

/**
 * Alvo do nowcast: Ipiranga/PR. Valor histórico do projeto (hardcoded em
 * llm-formatter, nowcast-vlm e frontend) centralizado aqui. Nota: pode
 * estar ~50km ao norte do centro oficial do município (-25.478, -50.583)
 * — verificar com o Dave antes de corrigir (afeta ETA/veredictos).
 */
export const TARGET_IPIRANGA = { lat: -25.0244, lon: -50.5847 } as const;

let cached: { result: NowcastResult; at: number } | null = null;

export async function getRadarNowcast(): Promise<NowcastResult> {
	if (cached && Date.now() - cached.at < TTL_MS) {
		return cached.result;
	}

	try {
		// 1. usa o radar do estado (já sincronizado), senão busca direto
		let radar = getCachedWeatherState()?.radar ?? null;
		if (!radar || radar.radar.past.length === 0) {
			logger.info("Nowcast: estado sem radar, buscando do RainViewer");
			radar = await fetchRainViewerRadar();
		}

		// 2. analisa os 3 frames mais recentes do grid 4x4 da região,
		//    avaliando TODOS os núcleos fortes contra Ipiranga
		const result = await analyzeRadarNowcast(
			radar.host,
			radar.radar.past,
			REGION_GRID,
			3,
			TARGET_IPIRANGA,
		);

		cached = { result, at: Date.now() };
		logger.info("Nowcast calculado", {
			frames: result.frames.length,
			maxDbz: result.currentMaxDbz,
			cells: result.frames[result.frames.length - 1]?.cells.length ?? 0,
			threats: result.threats.length,
			movement: result.movement
				? `${result.movement.directionDeg}° ${result.movement.speedKmh}km/h`
				: null,
		});
		return result;
	} catch (err) {
		logger.warn("Nowcast failed", { error: String(err) });
		return {
			analyzedAt: Date.now(),
			frames: [],
			movement: null,
			currentMaxDbz: -100,
			currentDominant: "none",
			nearestCell: null,
			threats: [],
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

/** Invalida o cache (chamado após novo sync de radar, se necessário) */
export function invalidateNowcastCache(): void {
	cached = null;
}
