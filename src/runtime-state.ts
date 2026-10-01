/**
 * Estado de runtime compartilhado do Monitor Ipiranga — extraído de index.ts
 * (01/10/2026). Vive separado para que index.ts (router) e sync-weather.ts
 * (ciclo de clima) usem o mesmo estado sem dependência circular.
 */
import { getWeatherStateCache, initDb } from "./db.js";
import {
	getCachedWeatherState,
	setCachedWeatherState,
} from "./weather-collector.js";
import { EventTracker } from "./state.js";
import { logger } from "./logger.js";
import type { WeatherState } from "./types.js";

let isInitialized = false;
let tracker: EventTracker;

/** TTL da cópia de estado servida pelo Turso (cache de read). */
const TURSO_STATE_TTL_MS = 15 * 60_000;

export function getTracker(): EventTracker {
	return tracker;
}

export async function ensureInitialized(): Promise<void> {
	if (!isInitialized) {
		await initDb();
		tracker = new EventTracker();
		await tracker.init();
		isInitialized = true;
	}
}

export async function loadWeatherState(
	maxAgeMs: number = TURSO_STATE_TTL_MS,
): Promise<WeatherState | null> {
	const mem = getCachedWeatherState();
	if (mem && Date.now() - mem.updatedAt <= 600_000) return mem;
	try {
		const cached = await getWeatherStateCache();
		if (cached && Date.now() - cached.updatedAt <= maxAgeMs) {
			const parsed = JSON.parse(cached.payload) as WeatherState;
			if (parsed && typeof parsed.updatedAt === "number") {
				setCachedWeatherState(parsed);
				return parsed;
			}
		}
	} catch (err) {
		logger.warn("Falha ao ler weather_state_cache", { error: String(err) });
	}
	return null;
}
