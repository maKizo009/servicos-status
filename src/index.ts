import {
	assessLevel,
	buildUnifiedReport,
	DEBOUNCE_THRESHOLD,
	deriveProbeStatus,
	runAllChecks,
} from "./checker.js";
import { loadConfig } from "./config.js";
import {
	closeDb,
	getDailyStatsSummary,
	getLatestBgpResults,
	getLatestConnectivityResults,
	getLatestNowcastBulletin,
	getLatestWeatherBulletin,
	getTelemetryStats,
	initDb,
	saveBgpResult,
	saveConnectivityResult,
	saveEventLog,
	saveNowcastBulletin,
	saveSignalReport,
	saveTelemetryLog,
} from "./db.js";
import { detectIsp } from "./isp-detector.js";
import {
	renderJsonLd,
	renderLlmsInstructions,
	renderLlmsTxt,
} from "./llm-formatter.js";
import { logger } from "./logger.js";
import { getRadarNowcast, REGION_GRID } from "./nowcast-service.js";
import { generateNowcastBulletin } from "./nowcast-vlm.js";
import { checkRateLimit, checkRateLimitScope } from "./rate-limiter.js";
import { EventTracker } from "./state.js";
import {
	sendCopelAlert,
	sendSaneparAlert,
	sendTelegramAlert,
	sendUnifiedReport,
} from "./telegram.js";
import type {
	AlertLevel,
	BgpResult,
	CheckResult,
	ConnectivityResult,
	OperatorName,
	RainAlertLevel,
	UnifiedReport,
	WeatherState,
} from "./types.js";
import {
	fetchCurrentWeather,
	fetchRainViewerRadar,
	getCachedWeatherState,
	setCachedWeatherState,
} from "./weather-collector.js";

const config = loadConfig();
let isInitialized = false;
let tracker: EventTracker;

/** Origens permitidas no CORS (whitelist — nunca `*`). */
const ALLOWED_ORIGINS = new Set([
	"https://servicos-status.vercel.app",
	"https://os-status.vercel.app",
	"http://localhost:3030",
]);

export async function ensureInitialized(): Promise<void> {
	if (!isInitialized) {
		await initDb();
		tracker = new EventTracker();
		await tracker.init();
		isInitialized = true;
	}
}

const checkResults: Map<OperatorName, CheckResult> = new Map();
let lastResults: ConnectivityResult[] = [];

let currentLevel: AlertLevel = "ok";
let lastUnifiedReportTime = 0;
let lastUnifiedReport: UnifiedReport | null = null;

/**
 * Debounce de falhas (Achado 4): contagem de ciclos consecutivos em que cada
 * host não respondeu (failure ou timeout). Só promove a "critical" após
 * DEBOUNCE_THRESHOLD ciclos. Resetado quando o host volta a responder.
 */
const failureCounts = new Map<string, number>();

function updateFailureCounts(
	results: Array<{
		host: string;
		success: boolean;
		error: string;
		probeStatus?: "ok" | "timeout" | "failure";
	}>,
): void {
	for (const r of results) {
		if (deriveProbeStatus(r) === "ok") {
			failureCounts.set(r.host, 0);
		} else {
			failureCounts.set(r.host, (failureCounts.get(r.host) ?? 0) + 1);
		}
	}
}

async function runChecks(): Promise<void> {
	await ensureInitialized();
	logger.info("Starting check cycle");

	const data = await runAllChecks(config, tracker);

	// Atualiza debounce ANTES de classificar (Achado 4): falha isolada = warn,
	// N consecutivas = critical.
	for (const op of data.operators) {
		updateFailureCounts(op.connectivityResults);
	}

	// Save operator results to DB and update in-memory state
	const allConnResults: ConnectivityResult[] = [];
	const allBgpResults: BgpResult[] = [];

	for (const op of data.operators) {
		for (const r of op.connectivityResults) await saveConnectivityResult(r);
		await saveBgpResult(op.bgpResult);

		allConnResults.push(...op.connectivityResults);
		allBgpResults.push(op.bgpResult);

		const opLevel = assessLevel(
			op.connectivityResults,
			op.bgpResult,
			config.latencyWarnMs,
			config.latencyCritMs,
			failureCounts,
			DEBOUNCE_THRESHOLD,
		);
		checkResults.set(op.name, {
			operator: op.name,
			connectivityResults: op.connectivityResults,
			bgpResult: op.bgpResult,
			status: opLevel,
			timestamp: data.timestamp,
		});
	}

	lastResults = allConnResults;

	// Operator aggregated alert (only on level change — existing behavior)
	const newLevel = assessLevel(
		allConnResults,
		allBgpResults,
		config.latencyWarnMs,
		config.latencyCritMs,
		failureCounts,
		DEBOUNCE_THRESHOLD,
	);
	if (newLevel !== currentLevel) {
		currentLevel = newLevel;
		const failedOps = [...checkResults.entries()]
			.filter(([, r]) => r.status !== "ok")
			.map(([name]) => name);
		const summary =
			failedOps.length > 0
				? `⚠️ Problemas em: ${failedOps.join(", ")}`
				: "✅ Todas as operadoras OK";

		await sendTelegramAlert({
			botToken: config.telegramBotToken,
			chatId: config.telegramChatId,
			level: newLevel,
			operatorResults: [...checkResults.entries()].map(([name, r]) => ({
				operator: name,
				status:
					r.status === "ok"
						? "✅ Normal"
						: r.status === "warn"
							? "⚠️ Atenção"
							: "❌ Crítico",
			})),
			summary,
		});
	}

	// Per-event alerts for COPEL
	for (const outage of data.newCopelOutages) {
		await sendCopelAlert(
			outage,
			config.telegramBotToken,
			config.telegramChatId,
		);
		await saveEventLog(
			"copel",
			`Queda de Energia (${outage.ehProgramada ? "Programada" : "Emergencial"})`,
			outage.bairro || "Ipiranga",
			`Equipe: ${outage.statusEquipe || "Pendente"} | Previsão: ${outage.previsaoRestabelecimento || "Sem previsão"}`,
			outage.qtdConsumidores || 0,
		);
	}

	// Per-event alerts for Sanepar
	for (const intr of data.newSaneparInterruptions) {
		await sendSaneparAlert(
			intr,
			config.telegramBotToken,
			config.telegramChatId,
		);
		await saveEventLog(
			"sanepar",
			`Interrupção de Água - ${intr.motivo || "Manutenção"}`,
			intr.bairro || intr.cidade || "Ipiranga",
			`Início: ${intr.inicio} | Fim: ${intr.fim}`,
			0,
		);
	}

	// Build and optionally send unified report
	lastUnifiedReport = await buildUnifiedReport(
		data,
		config.latencyWarnMs,
		config.latencyCritMs,
		failureCounts,
		DEBOUNCE_THRESHOLD,
	);
	const now = Date.now();
	if (
		config.unifiedReportIntervalMs > 0 &&
		now - lastUnifiedReportTime >= config.unifiedReportIntervalMs
	) {
		lastUnifiedReportTime = now;
		await sendUnifiedReport(
			lastUnifiedReport,
			config.telegramBotToken,
			config.telegramChatId,
		);
	}

	logger.info("Check cycle completed", {
		activeCopel: data.copelOutages.length,
		newCopel: data.newCopelOutages.length,
		activeSanepar: data.saneparInterruptions.length,
		newSanepar: data.newSaneparInterruptions.length,
		alertLevel: currentLevel,
	});
}

function handleHealth(): Response {
	const levelCounts = {
		critical: [...checkResults.values()].filter((r) => r.status === "critical")
			.length,
		warn: [...checkResults.values()].filter((r) => r.status === "warn").length,
		ok: [...checkResults.values()].filter((r) => r.status === "ok").length,
	};
	const healthy = levelCounts.critical === 0 && levelCounts.warn === 0;

	return Response.json({
		status: healthy ? "healthy" : "degraded",
		level: currentLevel,
		uptime: Math.floor((Date.now() - startTime) / 1000),
		operatorCount: checkResults.size,
		levels: levelCounts,
		lastCheck: lastResults.length > 0 ? lastResults[0].timestamp : null,
		timestamp: Date.now(),
	});
}

function handleStatus(): Response {
	const results = [...checkResults.entries()].map(([name, r]) => ({
		operator: name,
		status: r.status,
		connectivity: r.connectivityResults.map((c) => ({
			label: c.label,
			success: c.success,
			latencyMs: c.latencyMs,
			error: c.error,
			probeStatus: c.probeStatus ?? deriveProbeStatus(c),
		})),
		bgp: r.bgpResult
			? {
					asn: r.bgpResult.asn,
					prefixCountV4: r.bgpResult.prefixCountV4,
					prefixCountV6: r.bgpResult.prefixCountV6,
					samplePrefixes: r.bgpResult.samplePrefixes,
					error: r.bgpResult.error,
				}
			: null,
	}));

	return Response.json({
		level: currentLevel,
		operators: results,
		timestamp: Date.now(),
	});
}

async function handleHistory(url: URL): Promise<Response> {
	// Clamp de input: limit ausente/0/negativo/NaN vira 100; teto de 1000
	// (achado pentest: limit=-5 retornava o histórico inteiro).
	const limitRaw = Number(url.searchParams.get("limit"));
	const limit =
		Number.isFinite(limitRaw) && limitRaw > 0
			? Math.min(Math.floor(limitRaw), 1000)
			: 100;

	return Response.json({
		connectivity: await getLatestConnectivityResults(limit),
		bgp: await getLatestBgpResults(limit),
	});
}

function handleServices(): Response {
	if (!lastUnifiedReport) {
		return Response.json({ services: [], generatedAt: null });
	}
	return Response.json(lastUnifiedReport);
}

let weatherInterval: ReturnType<typeof setInterval> | null = null;

/** TTL do boletim narrativo do nowcast (Camada B): vale até a próxima leitura de radar (10 min). */
const NOWCAST_BULLETIN_TTL_MS = 600_000;

/** Exportado para o /api/cron (api/cron.ts) rodar o ciclo completo de clima+radar+NIM. */
export async function syncWeatherCycle(): Promise<WeatherState> {
	await ensureInitialized();
	logger.info("Starting weather & radar sync cycle...");
	const [radar, weatherInfo] = await Promise.all([
		fetchRainViewerRadar(),
		fetchCurrentWeather(),
	]);

	// Boletim da tabela legada (weather_bulletins, formato "NIM texto" que não
	// é mais gravado): só é usado se FRESCO (<60 min), senão a Camada B
	// (nowcastBulletin VLM/heurística) é a única fonte do boletim atual.
	const existingBulletin = await getLatestWeatherBulletin();
	const freshLegacyBulletin =
		existingBulletin && Date.now() - existingBulletin.generatedAt < 60 * 60_000
			? existingBulletin
			: null;

	const state: WeatherState = {
		municipio: config.municipio || "Ipiranga",
		tempC: weatherInfo.tempC,
		condition: weatherInfo.condition,
		rainProbabilityPct: weatherInfo.rainProbabilityPct,
		windKmh: weatherInfo.windKmh,
		humidityPct: weatherInfo.humidityPct,
		hasRegionalRain: radar.hasRegionalRain || false,
		regionalRainAlert: radar.hasRegionalRain
			? "🌩️ Núcleos de chuva detectados na região dos Campos Gerais. Atenção para potencial deslocamento de instabilidades e oscilações na rede elétrica (COPEL)."
			: "Sem instabilidades ativas no radar regional.",
		hourlyForecast: weatherInfo.hourlyForecast || [],
		radar,
		bulletin: freshLegacyBulletin,
		updatedAt: Date.now(),
	};

	setCachedWeatherState(state);

	// Nowcast determinístico (Camada A): analisa núcleos + movimento do radar
	try {
		const nowcast = await getRadarNowcast();
		state.nowcast = nowcast;
		// FONTE DA VERDADE: o alerta regional (card COPEL, dashboard) passa a
		// ser dirigido pelos GATES DE RELEVÂNCIA (distância + ETA + direção),
		// não pela intensidade bruta do frame. Incidente 2026-08-12: núcleo
		// extreme a 589 km (RS) acendia "Alerta de Tempestade" com o mapa
		// limpo no PR. Agora só a zona IMINENTE (≤80 km, ETA ≤120 min)
		// liga o card; vigilância (≤200 km, ETA ≤360 min) informa sem alertar.
		if (nowcast.currentDominant === "none" || nowcast.frames.length === 0) {
			state.hasRegionalRain = false;
			state.alertLevel = "none";
			state.nearestThreatKm = null;
			state.regionalRainAlert =
				"Sem instabilidades ativas no radar regional (análise determinística de núcleos).";
		} else {
			const intensityLabel: Record<string, string> = {
				light: "fraca",
				moderate: "moderada",
				heavy: "forte",
				extreme: "muito forte (temporal)",
			};
			const m = nowcast.movement;
			// Núcleos por zona de relevância (Camada A). threats já vem
			// ordenado por perigo (aproximando com menor ETA primeiro).
			const nearestAlert =
				nowcast.threats.find((t) => t.relevanceZone === "alert") ?? null;
			const nearestWatch =
				nowcast.threats.find((t) => t.relevanceZone === "watch") ?? null;
			const topThreat = nowcast.threats[0] ?? null;
			const alertLevel: RainAlertLevel = nearestAlert
				? "alert"
				: nearestWatch
					? "watch"
					: "monitor";
			state.alertLevel = alertLevel;
			state.nearestThreatKm = topThreat
				? Math.round(topThreat.distToTargetKm)
				: null;

			const threatLabel =
				topThreat &&
				topThreat.intensity !== "light" &&
				topThreat.intensity !== "moderate"
					? (intensityLabel[topThreat.intensity] ?? topThreat.intensity)
					: null;

			if (alertLevel === "alert") {
				const t = nearestAlert;
				const etaTxt =
					t?.threat?.approach === "approaching" && t.threat.etaMin != null
						? `, aproximando-se (ETA ~${Math.round(t.threat.etaMin)} min)`
						: "";
				state.hasRegionalRain = true;
				state.regionalRainAlert = `🌩️ Núcleo de chuva ${threatLabel ?? "forte"} detectado a ~${Math.round(t?.distToTargetKm ?? 0)} km de Ipiranga${etaTxt}. Atenção a oscilações na rede elétrica (COPEL).`;
			} else if (alertLevel === "watch") {
				const t = nearestWatch;
				const etaTxt =
					t?.threat?.approach === "approaching" && t.threat.etaMin != null
						? ` (ETA ~${Math.round(t.threat.etaMin / 60)} h)`
						: "";
				state.hasRegionalRain = false;
				state.regionalRainAlert = `👁️ Vigilância: núcleo de chuva ${threatLabel ?? "forte"} detectado a ~${Math.round(t?.distToTargetKm ?? 0)} km de Ipiranga${etaTxt}. Sem alerta iminente, acompanhe.`;
			} else {
				state.hasRegionalRain = false;
				state.regionalRainAlert = `ℹ️ Monitoramento: atividade de radar detectada a ${topThreat ? `~${Math.round(topThreat.distToTargetKm)} km` : "grande distância"} de Ipiranga. Sem risco iminente no momento.`;
			}
		}
		setCachedWeatherState(state);
		logger.info("Nowcast integrado ao estado de clima", {
			dominant: nowcast.currentDominant,
			maxDbz: nowcast.currentMaxDbz,
			alertLevel: state.alertLevel,
			nearestThreatKm: state.nearestThreatKm,
			threatsAlert: nowcast.threats.filter((t) => t.relevanceZone === "alert")
				.length,
			threatsWatch: nowcast.threats.filter((t) => t.relevanceZone === "watch")
				.length,
			threatsMonitor: nowcast.threats.filter(
				(t) => t.relevanceZone === "monitor",
			).length,
			movement: nowcast.movement
				? `${nowcast.movement.directionDeg}° ${nowcast.movement.speedKmh}km/h`
				: null,
		});

		// Camada B: boletim narrativo (VLM NIM ou heurística).
		// Persistido no DB e reutilizado até a próxima leitura de radar (15 min) —
		// evita regerar texto a cada reload/cold start e gasta cota NIM à toa.
		if (state.radar) {
			const cachedBulletin = await getLatestNowcastBulletin();
			const bulletinAgeMs = cachedBulletin
				? Date.now() - cachedBulletin.generatedAt
				: Infinity;

			if (cachedBulletin && bulletinAgeMs < NOWCAST_BULLETIN_TTL_MS) {
				state.nowcastBulletin = cachedBulletin;
				logger.info("Boletim nowcast reutilizado do cache persistido", {
					ageMin: Math.round(bulletinAgeMs / 60000),
					source: cachedBulletin.source,
				});
			} else {
				// Concatenação de fontes (ECMWF + radar): o VLM recebe a
				// previsão numérica junto com o nowcast para decidir de forma
				// probabilística — e ser honesto quando as fontes divergem.
				const bulletin = await generateNowcastBulletin(
					nowcast,
					state.radar.host,
					state.radar.radar.past,
					REGION_GRID,
					{
						rainProbabilityPct: weatherInfo.rainProbabilityPct,
						hourlyForecast: weatherInfo.hourlyForecast || [],
					},
					{
						alertLevel: state.alertLevel ?? "monitor",
						nearestThreatKm: state.nearestThreatKm ?? null,
					},
				);
				// Falha pontual do VLM (heurística) não pode "sujar" o boletim:
				// se já existe um boletim VLM com < 60 min, mantém ele em vez de
				// persistir a heurística (incidente 2026-08-12: heuristic grudou
				// por horas via TTL de 10 min).
				if (
					bulletin.source === "heuristic" &&
					cachedBulletin &&
					cachedBulletin.source !== "heuristic" &&
					Date.now() - cachedBulletin.generatedAt < 60 * 60_000
				) {
					logger.warn("Camada B: VLM falhou — mantendo boletim VLM anterior", {
						idadeMin: Math.round(
							(Date.now() - cachedBulletin.generatedAt) / 60_000,
						),
						anterior: cachedBulletin.source,
					});
					state.nowcastBulletin = cachedBulletin;
				} else {
					state.nowcastBulletin = bulletin;
					await saveNowcastBulletin(bulletin.text, bulletin.source);
					logger.info("Boletim nowcast (Camada B) gerado e persistido", {
						source: bulletin.source,
					});
				}
			}

			// O boletim principal do dashboard/llms.txt é o texto do VLM vision.
			// O antigo "NIM texto" (Llama 8b) foi removido — um único boletim
			// coeso, gerado a partir dos dados do radar + veredito de ameaça.
			if (state.nowcastBulletin) {
				state.bulletin = {
					bulletin: state.nowcastBulletin.text,
					source: state.nowcastBulletin.source,
					generatedAt: state.nowcastBulletin.generatedAt,
				};
			}
			setCachedWeatherState(state);
		}
	} catch (err) {
		logger.warn("Nowcast falhou ao integrar ao estado", {
			error: String(err),
		});
	}

	logger.info("Weather & radar sync cycle completed", {
		tempC: state.tempC,
		condition: state.condition,
		radarStatus: radar.status,
	});

	return state;
}

/** Request aceito pelo handler: Web Request nativo ou objeto Node-style */
interface IncomingRequest {
	url?: string;
	method?: string;
	headers?: {
		get?: (name: string) => string | null;
		[name: string]: unknown;
	};
	body?: unknown;
	json?: () => Promise<unknown>;
}

function getHeader(req: IncomingRequest, name: string): string | null {
	if (!req) return null;
	if (req.headers && typeof req.headers.get === "function") {
		return req.headers.get(name);
	}
	if (req.headers) {
		const val = req.headers[name.toLowerCase()];
		if (Array.isArray(val)) return val[0] || null;
		if (typeof val === "string") return val;
	}
	return null;
}

function getClientIp(req: IncomingRequest): string {
	return (
		getHeader(req, "x-forwarded-for")?.split(",")[0]?.trim() ||
		getHeader(req, "x-real-ip") ||
		"unknown"
	);
}

async function getReqJson(req: IncomingRequest): Promise<unknown> {
	if (!req) return {};
	if (req.body && typeof req.body === "object") return req.body;
	if (typeof req.json === "function") {
		return await req.json().catch(() => ({}));
	}
	return {};
}

export async function handleRequest(
	reqIn: IncomingRequest | string,
): Promise<Response> {
	await ensureInitialized();

	// Normaliza: string (URL) vira objeto; Request nativo já é IncomingRequest
	const req: IncomingRequest =
		typeof reqIn === "string" ? { url: reqIn, method: "GET" } : reqIn;

	let rawUrl = req.url || "/";
	if (!rawUrl.startsWith("http://") && !rawUrl.startsWith("https://")) {
		const host = getHeader(req, "host") || "servicos-status.vercel.app";
		rawUrl = `http://${host}${rawUrl.startsWith("/") ? "" : "/"}${rawUrl}`;
	}

	const url = new URL(rawUrl);
	const path = url.pathname;
	const method = (req.method || "GET").toUpperCase();

	if (method === "OPTIONS") {
		const origin = getHeader(req, "origin");
		const headers: Record<string, string> = {
			"Access-Control-Allow-Methods": "GET, POST, OPTIONS, HEAD",
			"Access-Control-Allow-Headers": "Content-Type, Authorization",
		};
		if (origin && ALLOWED_ORIGINS.has(origin)) {
			headers["Access-Control-Allow-Origin"] = origin;
			headers["Vary"] = "Origin";
		}
		return new Response(null, { status: 204, headers });
	}

	// Rotas de leitura: rejeitar métodos de escrita (405) em vez de responder
	// 200 para POST/PUT/DELETE/PATCH (achado pentest 2026-08-12).
	const READ_ONLY_PATHS = new Set([
		"/health",
		"/llms.txt",
		"/llms-full.txt",
		"/llms-instructions.txt",
		"/api/status",
		"/api/services",
		"/api/report",
		"/api/weather",
		"/api/weather/radar",
		"/api/weather/nowcast",
		"/api/weather/json-ld",
		"/api/weather/bulletin",
		"/api/history",
		"/api/operators",
		"/api/bgp",
		"/api/stats/daily",
		"/api/stats",
		"/api/telemetry/stats",
		"/api/push/status",
	]);
	if (READ_ONLY_PATHS.has(path) && method !== "GET" && method !== "HEAD") {
		return new Response(JSON.stringify({ error: "Método não permitido" }), {
			status: 405,
			headers: { "Content-Type": "application/json", Allow: "GET, HEAD" },
		});
	}

	// Serve llms.txt endpoints without rate limits
	if (path === "/llms.txt" || path === "/llms-full.txt") {
		let state = getCachedWeatherState();
		// Staleness check (Achado 1): igual ao /api/weather — não servir estado
		// velho de instância quente. O sync reutiliza o boletim persistido no
		// Turso enquanto < 10 min, então não gasta cota NIM à toa.
		if (!state || Date.now() - state.updatedAt > 600_000) {
			state = await syncWeatherCycle();
		}
		const text = renderLlmsTxt(state, lastUnifiedReport);
		return new Response(text, {
			headers: {
				"Content-Type": "text/plain; charset=utf-8",
				// max-age reduzido + stale-while-revalidate: dado fresco com
				// latência de origem escondida da CDN.
				"Cache-Control": "public, max-age=120, stale-while-revalidate=60",
			},
		});
	}

	// Instruções para agentes separadas dos dados (Achado 7): /llms.txt só tem
	// dado + metadados; o imperativo fica aqui, fora do payload de dados.
	if (path === "/llms-instructions.txt") {
		return new Response(renderLlmsInstructions(), {
			headers: {
				"Content-Type": "text/plain; charset=utf-8",
				"Cache-Control": "public, max-age=3600",
			},
		});
	}

	// Rate limit all /api/* endpoints except /health
	if (path.startsWith("/api/")) {
		const ip = getClientIp(req);
		// Telemetria (pageview/heartbeat) e admin têm rate limits próprios
		// (o heartbeat roda a cada 60s por sessão — o limite comum de 10/min
		// bloquearia o próprio site).
		if (path === "/api/track") {
			const { allowed, retryAfter } = checkRateLimitScope(ip, 120, "track");
			if (!allowed) {
				return new Response(
					JSON.stringify({ error: "Too many requests", retryAfter }),
					{
						status: 429,
						headers: {
							"Content-Type": "application/json",
							"Retry-After": String(retryAfter),
						},
					},
				);
			}
		} else if (path.startsWith("/api/admin/")) {
			const { allowed, retryAfter } = checkRateLimitScope(ip, 20, "admin");
			if (!allowed) {
				return new Response(
					JSON.stringify({ error: "Too many requests", retryAfter }),
					{
						status: 429,
						headers: {
							"Content-Type": "application/json",
							"Retry-After": String(retryAfter),
						},
					},
				);
			}
		} else {
			const { allowed, retryAfter } = checkRateLimit(ip);
			if (!allowed) {
				return new Response(
					JSON.stringify({
						error: "Too many requests",
						retryAfter,
						limit: "10 requests per minute",
					}),
					{
						status: 429,
						headers: {
							"Content-Type": "application/json",
							"Retry-After": String(retryAfter),
							"X-RateLimit-Limit": "10",
							"X-RateLimit-Remaining": "0",
							"X-RateLimit-Reset": String(
								Math.ceil((Date.now() + retryAfter * 1000) / 1000),
							),
						},
					},
				);
			}
		}
	}

	try {
		if (path === "/health" || path === "/health/") return handleHealth();
		if (path === "/api/status") return handleStatus();
		if (path === "/api/services" || path === "/api/report") {
			if (!lastUnifiedReport) await runChecks();
			return handleServices();
		}
		if (path === "/api/weather" || path === "/api/weather/radar") {
			let state = getCachedWeatherState();
			// Instância quente serve state velho (cache em memória é por instância);
			// refaz o sync se o state tem mais de 10 min. O NIM não é chamado à toa:
			// o sync reutiliza o boletim persistido no Turso enquanto < 10 min.
			if (!state || Date.now() - state.updatedAt > 600_000) {
				state = await syncWeatherCycle();
			}
			return Response.json(
				state || { error: "Sem dados climatológicos no momento" },
				{ headers: { "Cache-Control": "public, max-age=30" } },
			);
		}
		if (path === "/api/weather/nowcast") {
			const nowcast = await getRadarNowcast();
			return Response.json(nowcast, {
				headers: { "Cache-Control": "public, max-age=240" },
			});
		}
		if (path === "/api/weather/json-ld") {
			const jsonLd = renderJsonLd(getCachedWeatherState(), lastUnifiedReport);
			return new Response(JSON.stringify(jsonLd, null, 2), {
				headers: {
					"Content-Type": "application/ld+json; charset=utf-8",
					"Cache-Control": "public, max-age=300",
				},
			});
		}
		if (path === "/api/weather/bulletin") {
			const state = getCachedWeatherState();
			// Instância fria não tem state em memória: fallback para o último
			// boletim persistido no Turso (Camada B) — nunca retorna vazio
			// sem necessidade.
			const cached = state?.nowcastBulletin ?? state?.bulletin ?? null;
			if (cached) {
				const text = "text" in cached ? cached.text : (cached.bulletin ?? null);
				return Response.json({
					bulletin: text,
					source: cached.source ?? null,
					timestamp: Date.now(),
				});
			}
			const persisted = await getLatestNowcastBulletin();
			return Response.json({
				bulletin: persisted?.text ?? null,
				source: persisted?.source ?? null,
				generatedAt: persisted?.generatedAt ?? null,
				timestamp: Date.now(),
			});
		}

		if (path === "/api/history") return handleHistory(url);
		if (path === "/api/operators") {
			return Response.json({ operators: Object.keys(config.operators) });
		}
		if (path === "/api/bgp") {
			return Response.json({ results: await getLatestBgpResults(20) });
		}
		if (path === "/api/check" && method === "POST") {
			// Dispara ciclo completo (probes externos + NIM + Telegram): só
			// com Bearer CRON_SECRET — nunca público (achado pentest:
			// qualquer um gastava cota e spammava alertas).
			const cronSecret = loadConfig().cronSecret;
			const auth = getHeader(req, "authorization") ?? "";
			if (!cronSecret || auth !== `Bearer ${cronSecret}`) {
				return new Response(
					JSON.stringify({ error: "Não autorizado" }),
					{
						status: 401,
						headers: { "Content-Type": "application/json" },
					},
				);
			}
			await runChecks();
			return Response.json({ status: "ok", timestamp: Date.now() });
		}
		// ===== Telemetria de uso (acessos, instalações, sessões) =====
		if (path === "/api/track" && method === "POST") {
			try {
				const { trackEvent } = await import("./admin.js");
				const body = (await getReqJson(req)) as {
					event?: string;
					sessionId?: string;
				};
				const tipo = String(body?.event ?? "");
				if (!["pageview", "install", "heartbeat"].includes(tipo)) {
					return new Response(JSON.stringify({ error: "evento inválido" }), {
						status: 400,
						headers: { "Content-Type": "application/json" },
					});
				}
				await trackEvent(tipo, body?.sessionId ? String(body.sessionId) : null);
				return Response.json({ status: "ok", timestamp: Date.now() });
			} catch (err: unknown) {
				const errMsg = err instanceof Error ? err.message : String(err);
				logger.error("Handler error", { path, error: errMsg });
				return new Response(JSON.stringify({ error: "Requisição inválida" }), {
					status: 400,
					headers: { "Content-Type": "application/json" },
				});
			}
		}
		// ===== Painel Admin (só o dono) =====
		if (path === "/api/admin/login" && method === "POST") {
			// Rate limit dedicado de login (5/min por IP), além do escopo
			// "admin" (20/min): corta rajadas de brute force. O atraso fixo
			// de 1.2s abaixo desacelera tentativas distribuídas.
			const { allowed, retryAfter } = checkRateLimitScope(
				getClientIp(req),
				5,
				"login",
			);
			if (!allowed) {
				return new Response(
					JSON.stringify({ error: "Too many requests", retryAfter }),
					{
						status: 429,
						headers: {
							"Content-Type": "application/json",
							"Retry-After": String(retryAfter),
						},
					},
				);
			}
			const {
				adminConfigured,
				adminEmail,
				createSessionToken,
				sessionCookie,
				verifyPassword,
			} = await import("./admin.js");
			if (!adminConfigured()) {
				return new Response(
					JSON.stringify({ error: "Admin não configurado" }),
					{ status: 503, headers: { "Content-Type": "application/json" } },
				);
			}
			const body = (await getReqJson(req)) as {
				email?: string;
				password?: string;
			};
			const ok =
				String(body?.email ?? "").toLowerCase() ===
					adminEmail().toLowerCase() &&
				verifyPassword(
					String(body?.password ?? ""),
					loadConfig().adminPasswordHash,
				);
			// Atraso fixo anti brute-force (serverless não tem memória de
			// tentativas entre instâncias — o atraso uniformiza a força).
			await new Promise((r) => setTimeout(r, 1200));
			if (!ok) {
				return new Response(
					JSON.stringify({ error: "Credenciais inválidas" }),
					{ status: 401, headers: { "Content-Type": "application/json" } },
				);
			}
			const token = createSessionToken();
			return new Response(JSON.stringify({ status: "ok" }), {
				status: 200,
				headers: {
					"Content-Type": "application/json",
					"Set-Cookie": sessionCookie(token),
				},
			});
		}
		if (path === "/api/admin/logout" && method === "POST") {
			const { clearSessionCookie } = await import("./admin.js");
			return new Response(JSON.stringify({ status: "ok" }), {
				status: 200,
				headers: {
					"Content-Type": "application/json",
					"Set-Cookie": clearSessionCookie(),
				},
			});
		}
		if (path === "/api/admin/me" && method === "GET") {
			const {
				adminConfigured,
				adminEmail,
				getSessionTokenFromCookie,
				verifySessionToken,
			} = await import("./admin.js");
			const token = getSessionTokenFromCookie(getHeader(req, "cookie"));
			const authed = verifySessionToken(token);
			return Response.json({
				authed,
				// Não expor "admin existe" para quem não está autenticado
				// (achado pentest: recon via /api/admin/me sem auth).
				configured: authed ? adminConfigured() : false,
				email: authed ? adminEmail() : null,
				timestamp: Date.now(),
			});
		}
		if (path === "/api/admin/stats" && method === "GET") {
			const { getAdminStats, getSessionTokenFromCookie, verifySessionToken } =
				await import("./admin.js");
			const token = getSessionTokenFromCookie(getHeader(req, "cookie"));
			if (!verifySessionToken(token)) {
				return new Response(JSON.stringify({ error: "Não autenticado" }), {
					status: 401,
					headers: { "Content-Type": "application/json" },
				});
			}
			return Response.json(await getAdminStats());
		}
		// ===== WebAuthn (impressão digital / passkey) =====
		const authOk = await (async () => {
			const { getSessionTokenFromCookie, verifySessionToken } = await import(
				"./admin.js"
			);
			return verifySessionToken(
				getSessionTokenFromCookie(getHeader(req, "cookie")),
			);
		})();
		if (path === "/api/admin/webauthn/register/begin" && method === "POST") {
			if (!authOk) {
				return new Response(JSON.stringify({ error: "Não autenticado" }), {
					status: 401,
					headers: { "Content-Type": "application/json" },
				});
			}
			const { webauthnRegisterBegin } = await import("./admin.js");
			const out = await webauthnRegisterBegin(getHeader(req, "host"));
			if (!out) {
				return new Response(
					JSON.stringify({ error: "WebAuthn indisponível" }),
					{ status: 500, headers: { "Content-Type": "application/json" } },
				);
			}
			return Response.json(out);
		}
		if (path === "/api/admin/webauthn/register/complete" && method === "POST") {
			if (!authOk) {
				return new Response(JSON.stringify({ error: "Não autenticado" }), {
					status: 401,
					headers: { "Content-Type": "application/json" },
				});
			}
			const { webauthnRegisterComplete } = await import("./admin.js");
			const out = await webauthnRegisterComplete(
				await getReqJson(req),
				getHeader(req, "origin"),
			);
			return Response.json(out, { status: out.ok ? 200 : 400 });
		}
		if (path === "/api/admin/webauthn/login/begin" && method === "POST") {
			const { webauthnLoginBegin } = await import("./admin.js");
			const out = await webauthnLoginBegin(getHeader(req, "host"));
			if (!out) {
				return new Response(
					JSON.stringify({ error: "Nenhuma passkey registrada" }),
					{ status: 404, headers: { "Content-Type": "application/json" } },
				);
			}
			return Response.json(out);
		}
		if (path === "/api/admin/webauthn/login/complete" && method === "POST") {
			const { sessionCookie, webauthnLoginComplete } = await import(
				"./admin.js"
			);
			const out = await webauthnLoginComplete(
				await getReqJson(req),
				getHeader(req, "origin"),
			);
			if (!out.ok || !out.token) {
				return new Response(JSON.stringify({ error: out.error ?? "Falha" }), {
					status: 400,
					headers: { "Content-Type": "application/json" },
				});
			}
			return new Response(JSON.stringify({ status: "ok" }), {
				status: 200,
				headers: {
					"Content-Type": "application/json",
					"Set-Cookie": sessionCookie(out.token),
				},
			});
		}
		// ===== Push Web (PWA) — inscrições e teste =====
		if (path === "/api/push/status") {
			const { countPushSubscriptions, pushConfigured } = await import(
				"./push.js"
			);
			const config = loadConfig();
			return Response.json({
				configured: pushConfigured(),
				vapidPublicKey: config.vapidPublicKey || null,
				subscribers: await countPushSubscriptions().catch(() => 0),
				timestamp: Date.now(),
			});
		}
		if (path === "/api/push/subscribe" && method === "POST") {
			try {
				const { savePushSubscription } = await import("./push.js");
				const body = (await getReqJson(req)) as {
					endpoint?: string;
					keys?: { p256dh?: string; auth?: string };
				};
				if (!body?.endpoint || !body?.keys?.p256dh || !body?.keys?.auth) {
					return new Response(
						JSON.stringify({ error: "Inscrição incompleta (endpoint/keys)" }),
						{ status: 400, headers: { "Content-Type": "application/json" } },
					);
				}
				await savePushSubscription({
					endpoint: body.endpoint,
					keys: { p256dh: body.keys.p256dh, auth: body.keys.auth },
				});
				return Response.json({ status: "ok", timestamp: Date.now() });
			} catch (err: unknown) {
				const errMsg = err instanceof Error ? err.message : String(err);
				logger.error("Handler error", { path, error: errMsg });
				return new Response(JSON.stringify({ error: "Requisição inválida" }), {
					status: 400,
					headers: { "Content-Type": "application/json" },
				});
			}
		}
		if (path === "/api/push/unsubscribe" && method === "POST") {
			try {
				const { removePushSubscription } = await import("./push.js");
				const body = (await getReqJson(req)) as { endpoint?: string };
				if (!body?.endpoint) {
					return new Response(JSON.stringify({ error: "endpoint ausente" }), {
						status: 400,
						headers: { "Content-Type": "application/json" },
					});
				}
				await removePushSubscription(body.endpoint);
				return Response.json({ status: "ok", timestamp: Date.now() });
			} catch (err: unknown) {
				const errMsg = err instanceof Error ? err.message : String(err);
				logger.error("Handler error", { path, error: errMsg });
				return new Response(JSON.stringify({ error: "Requisição inválida" }), {
					status: 400,
					headers: { "Content-Type": "application/json" },
				});
			}
		}
		if (path === "/api/push/test" && method === "POST") {
			// Push para TODOS os inscritos do PWA: exige sessão admin
			// (achado pentest: endpoint público spammava todos os usuários).
			const { getSessionTokenFromCookie, verifySessionToken } = await import(
				"./admin.js"
			);
			if (
				!verifySessionToken(
					getSessionTokenFromCookie(getHeader(req, "cookie")),
				)
			) {
				return new Response(
					JSON.stringify({ error: "Não autenticado" }),
					{
						status: 401,
						headers: { "Content-Type": "application/json" },
					},
				);
			}
			// Envia um push de teste pra todos os inscritos (validar o fluxo).
			const { sendPushAlert } = await import("./push.js");
			const r = await sendPushAlert(
				"🔔 Monitor Ipiranga",
				"Teste de alerta — notificações funcionando!",
				"/",
			);
			return Response.json({ ...r, timestamp: Date.now() });
		}
		if (path === "/api/signal-report" && method === "POST") {
			try {
				const body = (await getReqJson(req)) as {
					operator: OperatorName;
					status: "ok" | "degraded" | "down";
					signalType: string;
					notes?: string;
				};
				if (!body.operator || !body.status || !body.signalType) {
					return new Response(
						JSON.stringify({ error: "Parâmetros inválidos" }),
						{ status: 400, headers: { "Content-Type": "application/json" } },
					);
				}
				const report = await saveSignalReport(
					body.operator,
					body.status,
					body.signalType,
					body.notes ?? "",
				);
				// Sem runChecks por request (achado pentest: cada POST público
				// rodava probes + NIM + alertas — DoS de custo). O ciclo roda
				// no cron (/api/cron) e no intervalo do worker.
				return Response.json({ status: "ok", report, timestamp: Date.now() });
			} catch (err: unknown) {
				const errMsg = err instanceof Error ? err.message : String(err);
				logger.error("Handler error", { path, error: errMsg });
				return new Response(JSON.stringify({ error: "Requisição inválida" }), {
					status: 400,
					headers: { "Content-Type": "application/json" },
				});
			}
		}
		if (path === "/api/telemetry/stats") {
			return Response.json({
				stats: await getTelemetryStats(30),
				timestamp: Date.now(),
			});
		}
		if (path === "/api/stats/daily" || path === "/api/stats") {
			return Response.json({
				daily: await getDailyStatsSummary(),
				timestamp: Date.now(),
			});
		}
		if (
			path === "/api/telemetry" &&
			(method === "HEAD" || (method === "GET" && url.searchParams.has("ping")))
		) {
			return new Response(null, { status: 200 });
		}
		if (path === "/api/telemetry" && method === "POST") {
			try {
				const ip = getClientIp(req) === "unknown" ? "127.0.0.1" : getClientIp(req);
				const body = (await getReqJson(req)) as {
					rttMs?: number;
					effectiveType?: string;
					operator?: OperatorName;
				};

				const isp = await detectIsp(ip);
				const operator = body.operator || isp.operator;
				const rttMs = Number(body.rttMs) || 0;
				const effectiveType = String(body.effectiveType || "");

				await saveTelemetryLog(
					ip,
					operator,
					isp.ispName ||
						(operator ? `${operator} (Rede Móvel)` : "Banda Larga"),
					rttMs,
					effectiveType,
				);
				// Sem runChecks por request (achado pentest: DoS de custo —
				// cada POST de telemetria rodava probes + NIM + alertas).

				return Response.json({
					status: "ok",
					isp,
					timestamp: Date.now(),
				});
			} catch (err: unknown) {
				const errMsg = err instanceof Error ? err.message : String(err);
				logger.error("Handler error", { path, error: errMsg });
				return new Response(JSON.stringify({ error: "Requisição inválida" }), {
					status: 400,
					headers: { "Content-Type": "application/json" },
				});
			}
		}
		// Static file fallback for local Bun runtime
		if (typeof Bun !== "undefined" && typeof Bun.file === "function") {
			const staticPath = `${import.meta.dir}/public${path === "/" ? "/index.html" : path}`;
			const staticFile = Bun.file(staticPath);
			if (await staticFile.exists()) {
				return new Response(staticFile);
			}
		}

		return new Response("Not found", { status: 404 });
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		logger.error("API error", {
			path,
			error: msg,
			stack: err instanceof Error ? err.stack : undefined,
		});
		// Nunca vazar mensagens internas (stack/paths de arquivos) pro cliente
		// (achado pentest: catch devolvia {error: msg} em 500).
		return new Response(JSON.stringify({ error: "Erro interno" }), {
			status: 500,
			headers: { "Content-Type": "application/json" },
		});
	}
}

const startTime = Date.now();
let checkInterval: ReturnType<typeof setInterval> | null = null;
let server: { stop: () => void } | null = null;

async function runOnce(): Promise<void> {
	await ensureInitialized();
	logger.info("Running single check cycle (--once)");

	const data = await runAllChecks(config, tracker);

	for (const op of data.operators) {
		for (const r of op.connectivityResults) saveConnectivityResult(r);
		saveBgpResult(op.bgpResult);
	}

	for (const outage of data.newCopelOutages) {
		await sendCopelAlert(
			outage,
			config.telegramBotToken,
			config.telegramChatId,
		);
	}

	for (const intr of data.newSaneparInterruptions) {
		await sendSaneparAlert(
			intr,
			config.telegramBotToken,
			config.telegramChatId,
		);
	}

	logger.info("Single check cycle completed", {
		operators: data.operators.length,
		newCopel: data.newCopelOutages.length,
		newSanepar: data.newSaneparInterruptions.length,
	});
}

async function main(): Promise<void> {
	if (process.argv.includes("--once")) {
		await runOnce();
		closeDb();
		process.exit(0);
	}

	logger.info("Starting services-health monitor", {
		operators: Object.keys(config.operators),
		municipio: config.municipio || "(não configurado)",
		checkIntervalMs: config.checkIntervalMs,
		httpPort: config.httpPort,
	});

	// Start HTTP server immediately so Healthcheck probes (Docker, Fly.io, Render) pass right away
	server = Bun.serve({
		port: config.httpPort,
		fetch: (req: Request) => handleRequest(req as unknown as IncomingRequest),
	});

	logger.info(`HTTP server listening on :${config.httpPort}`);

	process.on("SIGTERM", gracefulShutdown);
	process.on("SIGINT", gracefulShutdown);

	// Run initial checks asynchronously without blocking port binding
	Promise.all([runChecks(), syncWeatherCycle()]).catch((err) => {
		logger.error("Error during initial check cycle", { error: String(err) });
	});

	checkInterval = setInterval(runChecks, config.checkIntervalMs);
	// Ciclo de clima/radar/boletim a cada 10 min (era 15) — pedido do Dave
	// 2026-08-12: "diminua o tempo de verificação para 10 minutos".
	weatherInterval = setInterval(syncWeatherCycle, 600_000);
}

async function gracefulShutdown(): Promise<void> {
	logger.info("Shutting down gracefully...");

	if (checkInterval) clearInterval(checkInterval);
	if (weatherInterval) clearInterval(weatherInterval);
	if (server) server.stop();
	closeDb();

	logger.info("Shutdown complete");
	process.exit(0);
}

if (typeof Bun !== "undefined" && import.meta.path === Bun.main) {
	main().catch((err: unknown) => {
		const msg = err instanceof Error ? err.message : String(err);
		logger.error("Fatal error during startup", { error: msg });
		process.exit(1);
	});
}
