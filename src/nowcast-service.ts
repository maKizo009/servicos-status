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
 * Grid de tiles z=9 (4x4) cobrindo a mesma área do antigo tile z=7 (46,73):
 * x 184-187, y 292-295. Resolução ~4x melhor na localização dos núcleos
 * (~70km/tile → ~17km/tile) mantendo a cobertura regional.
 */
export const REGION_GRID = {
	z: 9,
	xMin: 184,
	yMin: 292,
	xMax: 187,
	yMax: 295,
} as const;

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

		// 2. analisa os 3 frames mais recentes da região (mosaico z=9)
		const result = await analyzeRadarNowcast(
			radar.host,
			radar.radar.past,
			REGION_GRID,
			3,
		);

		cached = { result, at: Date.now() };
		logger.info("Nowcast calculado", {
			frames: result.frames.length,
			maxDbz: result.currentMaxDbz,
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
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

/** Invalida o cache (chamado após novo sync de radar, se necessário) */
export function invalidateNowcastCache(): void {
	cached = null;
}
