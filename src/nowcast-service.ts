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
 * Tile z=7 (46,73) — ZOOM MÁXIMO real do radar RainViewer.
 * Testado em 08/08/2026: z≥8 retorna um PNG de erro de ~1.3KB
 * ("zoom level not supported") cujo texto branco é classificado pela
 * paleta como 68+ dBZ → falso positivo. Não subir além de z=7.
 */
export const REGION_TILE = { z: 7, x: 46, y: 73 } as const;

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

		// 2. analisa os 3 frames mais recentes da região (tile z=7)
		const result = await analyzeRadarNowcast(
			radar.host,
			radar.radar.past,
			REGION_TILE,
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
