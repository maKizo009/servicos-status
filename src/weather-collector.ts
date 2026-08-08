import { getLatestRadarCache, saveRadarCache } from "./db";
import { logger } from "./logger";
import type { RainViewerFrame, WeatherRadarData, WeatherState, HourlyForecastPoint } from "./types";

const RAINVIEWER_API_URL = "https://api.rainviewer.com/public/weather-maps.json";
// Modelo Europeu ECMWF IFS ("O Rei" da meteorologia)
const OPEN_METEO_API_URL =
	"https://api.open-meteo.com/v1/forecast?latitude=-25.0244&longitude=-50.5847&current_weather=true&hourly=temperature_2m,relativehumidity_2m,precipitation_probability,precipitation,cloudcover&models=ecmwf_ifs04&timezone=America%2FSao_Paulo";

let cachedWeatherState: WeatherState | null = null;

export async function fetchRainViewerRadar(): Promise<WeatherRadarData> {
	try {
		logger.info("Fetching RainViewer radar data...");
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), 10_000);

		const res = await fetch(RAINVIEWER_API_URL, {
			signal: controller.signal,
			headers: { "User-Agent": "ServicosIpirangaStatus/1.0 (+https://ipiranga.pr.gov.br)" },
		});
		clearTimeout(timeoutId);

		if (!res.ok) {
			throw new Error(`RainViewer HTTP Error ${res.status}: ${res.statusText}`);
		}

		const data = (await res.json()) as {
			host?: string;
			version?: string;
			generated?: number;
			radar?: { past?: RainViewerFrame[]; nowcast?: RainViewerFrame[] };
			satellite?: { infrared?: RainViewerFrame[] };
		};

		let hasRegionalRain = false;
		const hostUrl = data.host || "https://tilecache.rainviewer.com";
		const past = data.radar?.past || [];
		if (past.length > 0) {
			const lastPath = past[past.length - 1].path;
			// Scan regional tiles for Campos Gerais (z=6 x=23 y=37, z=7 x=46 y=73)
			try {
				const checkTiles = [
					`${hostUrl}${lastPath}/256/7/46/73/2/1_1.png`,
					`${hostUrl}${lastPath}/256/7/45/73/2/1_1.png`,
					`${hostUrl}${lastPath}/256/7/46/74/2/1_1.png`,
					`${hostUrl}${lastPath}/256/7/46/72/2/1_1.png`,
					`${hostUrl}${lastPath}/256/7/47/73/2/1_1.png`,
					`${hostUrl}${lastPath}/256/6/23/37/2/1_1.png`,
				];
				for (const tileUrl of checkTiles) {
					const tRes = await fetch(tileUrl);
					if (tRes.ok) {
						const buf = await tRes.arrayBuffer();
						if (buf.byteLength > 1000) {
							hasRegionalRain = true;
							break;
						}
					}
				}
			} catch {
				// Ignore scan errors
			}
		}

		const radarData: WeatherRadarData = {
			host: hostUrl,
			version: data.version || "v2",
			generated: data.generated || Math.floor(Date.now() / 1000),
			radar: {
				past: data.radar?.past || [],
				nowcast: data.radar?.nowcast || [],
			},
			satellite: {
				infrared: data.satellite?.infrared || [],
			},
			status: "ok",
			lastSuccessTime: Date.now(),
			hasRegionalRain,
		};

		await saveRadarCache(radarData);
		logger.info("RainViewer radar data synced successfully", {
			pastFrames: radarData.radar.past.length,
			hasRegionalRain,
		});

		return radarData;
	} catch (err: unknown) {
		const errMsg = err instanceof Error ? err.message : String(err);
		logger.warn("RainViewer sync failed, applying resilience fallback", { error: errMsg });

		const fallback = await getLatestRadarCache();
		if (fallback) {
			fallback.status = "degraded";
			fallback.error = `Fallback ativado (${errMsg})`;
			return fallback;
		}

		return {
			host: "https://tilecache.rainviewer.com",
			version: "v2",
			generated: Math.floor(Date.now() / 1000),
			radar: { past: [], nowcast: [] },
			satellite: { infrared: [] },
			status: "down",
			lastSuccessTime: 0,
			error: `Serviço indisponível: ${errMsg}`,
		};
	}
}

export async function fetchCurrentWeather(): Promise<{
	tempC: number;
	condition: string;
	rainProbabilityPct: number;
	windKmh: number;
	humidityPct: number;
	hourlyForecast: HourlyForecastPoint[];
}> {
	try {
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), 6_000);

		const res = await fetch(OPEN_METEO_API_URL, { signal: controller.signal });
		clearTimeout(timeoutId);

		if (!res.ok) {
			throw new Error(`OpenMeteo HTTP ${res.status}`);
		}

		const data = (await res.json()) as {
			current_weather?: {
				temperature?: number;
				windspeed?: number;
				weathercode?: number;
			};
			hourly?: {
				time?: string[];
				temperature_2m?: number[];
				precipitation_probability?: number[];
				precipitation?: number[];
				relativehumidity_2m?: number[];
			};
		};

		const tempC = Math.round(data.current_weather?.temperature ?? 21);
		const windKmh = Math.round(data.current_weather?.windspeed ?? 12);
		const code = data.current_weather?.weathercode ?? 0;
		const rainProbabilityPct = data.hourly?.precipitation_probability?.[0] ?? 15;
		const humidityPct = data.hourly?.relativehumidity_2m?.[0] ?? 70;

		const hourlyForecast: HourlyForecastPoint[] = [];
		const times = data.hourly?.time || [];
		const temps = data.hourly?.temperature_2m || [];
		const probs = data.hourly?.precipitation_probability || [];
		const precips = data.hourly?.precipitation || [];

		const nowHour = new Date().getHours();
		for (let i = 0; i < Math.min(times.length, 24); i++) {
			const ptTime = new Date(times[i]);
			if (ptTime.getHours() >= nowHour && hourlyForecast.length < 6) {
				hourlyForecast.push({
					time: ptTime.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }),
					tempC: Math.round(temps[i] ?? tempC),
					rainProbabilityPct: Math.round(probs[i] ?? rainProbabilityPct),
					precipitationMm: Number((precips[i] ?? 0).toFixed(1)),
				});
			}
		}

		const conditionMap: Record<number, string> = {
			0: "Céu Limpo",
			1: "Predominantemente Ensolarado",
			2: "Parcialmente Nublado",
			3: "Encoberto",
			45: "Nevoeiro",
			48: "Geada / Nevoeiro",
			51: "Garoa Leve",
			53: "Garoa Moderada",
			55: "Garoa Densa",
			61: "Chuva Leve",
			63: "Chuva Moderada",
			65: "Chuva Forte",
			80: "Pancadas de Chuva Leves",
			81: "Pancadas de Chuva Moderadas",
			82: "Pancadas de Chuva Violentas",
			95: "Temporal com Trovoadas",
			96: "Temporal com Granizo",
		};

		return {
			tempC,
			condition: conditionMap[code] || "Nublado",
			rainProbabilityPct,
			windKmh,
			humidityPct,
			hourlyForecast,
		};
	} catch (err: unknown) {
		logger.warn("Weather forecast fetch failed, using defaults", { error: String(err) });
		return {
			tempC: 22,
			condition: "Parcialmente Nublado",
			rainProbabilityPct: 20,
			windKmh: 14,
			humidityPct: 68,
			hourlyForecast: [],
		};
	}
}

export function setCachedWeatherState(state: WeatherState): void {
	cachedWeatherState = state;
}

export function getCachedWeatherState(): WeatherState | null {
	return cachedWeatherState;
}
