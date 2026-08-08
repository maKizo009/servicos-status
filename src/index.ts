import { assessLevel, buildUnifiedReport, runAllChecks } from "./checker.js";
import { loadConfig } from "./config.js";
import {
	closeDb,
	getDailyStatsSummary,
	getLatestBgpResults,
	getLatestConnectivityResults,
	getLatestPortalResults,
	getLatestWeatherBulletin,
	getPortalHistory,
	getTelemetryStats,
	initDb,
	saveBgpResult,
	saveConnectivityResult,
	saveEventLog,
	savePortalResult,
	saveSignalReport,
	saveTelemetryLog,
} from "./db.js";
import { detectIsp } from "./isp-detector.js";
import {
	generateAiWeatherBulletin,
	renderJsonLd,
	renderLlmsTxt,
} from "./llm-formatter.js";
import { logger } from "./logger.js";
import { getRadarNowcast } from "./nowcast-service.js";
import { generateNowcastBulletin } from "./nowcast-vlm.js";
import { checkRateLimit } from "./rate-limiter.js";
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
	PortalResult,
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

export async function ensureInitialized(): Promise<void> {
	if (!isInitialized) {
		await initDb();
		tracker = new EventTracker();
		await tracker.init();
		isInitialized = true;
	}
}

const checkResults: Map<OperatorName, CheckResult> = new Map();
let lastResults: PortalResult[] = [];

let currentLevel: AlertLevel = "ok";
let lastUnifiedReportTime = 0;
let lastUnifiedReport: UnifiedReport | null = null;

async function runChecks(): Promise<void> {
	await ensureInitialized();
	logger.info("Starting check cycle");

	const data = await runAllChecks(config, tracker);

	// Save operator results to DB and update in-memory state
	const allPortalResults: PortalResult[] = [];
	const allConnResults: ConnectivityResult[] = [];
	const allBgpResults: BgpResult[] = [];

	for (const op of data.operators) {
		for (const r of op.portalResults) await savePortalResult(r);
		for (const r of op.connectivityResults) await saveConnectivityResult(r);
		await saveBgpResult(op.bgpResult);

		allPortalResults.push(...op.portalResults);
		allConnResults.push(...op.connectivityResults);
		allBgpResults.push(op.bgpResult);

		const opLevel = assessLevel(
			op.portalResults,
			op.connectivityResults,
			op.bgpResult,
			config.latencyWarnMs,
			config.latencyCritMs,
		);
		checkResults.set(op.name, {
			operator: op.name,
			portalResults: op.portalResults,
			connectivityResults: op.connectivityResults,
			bgpResult: op.bgpResult,
			status: opLevel,
			timestamp: data.timestamp,
		});
	}

	lastResults = allPortalResults;

	// Operator aggregated alert (only on level change — existing behavior)
	const newLevel = assessLevel(
		allPortalResults,
		allConnResults,
		allBgpResults,
		config.latencyWarnMs,
		config.latencyCritMs,
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
				portals: r.portalResults,
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
		totalPortals: allPortalResults.length,
		portalsOk: allPortalResults.filter((r) => r.success).length,
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
		portals: r.portalResults.map((p) => ({
			host: p.host,
			success: p.success,
			latencyMs: p.latencyMs,
			error: p.error,
		})),
		connectivity: r.connectivityResults.map((c) => ({
			label: c.label,
			success: c.success,
			latencyMs: c.latencyMs,
			error: c.error,
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
	const operator = url.searchParams.get("operator");
	const limit = Math.min(Number(url.searchParams.get("limit")) || 100, 1000);

	if (operator) {
		const history = await getPortalHistory(operator, limit);
		return Response.json({ operator, count: history.length, results: history });
	}

	return Response.json({
		portals: await getLatestPortalResults(limit),
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

async function syncWeatherCycle(): Promise<WeatherState> {
	await ensureInitialized();
	logger.info("Starting weather & radar sync cycle...");
	const [radar, weatherInfo] = await Promise.all([
		fetchRainViewerRadar(),
		fetchCurrentWeather(),
	]);

	const existingBulletin = await getLatestWeatherBulletin();

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
		bulletin: existingBulletin,
		updatedAt: Date.now(),
	};

	setCachedWeatherState(state);

	// Nowcast determinístico (Camada A): analisa núcleos + movimento do radar
	try {
		const nowcast = await getRadarNowcast();
		state.nowcast = nowcast;
		setCachedWeatherState(state);
		logger.info("Nowcast integrado ao estado de clima", {
			dominant: nowcast.currentDominant,
			maxDbz: nowcast.currentMaxDbz,
			movement: nowcast.movement
				? `${nowcast.movement.directionDeg}° ${nowcast.movement.speedKmh}km/h`
				: null,
		});

		// Camada B: boletim narrativo (VLM NIM ou heurística)
		if (state.radar) {
			const bulletin = await generateNowcastBulletin(
				nowcast,
				state.radar.host,
				state.radar.radar.past,
				{ z: 7, x: 46, y: 73 },
			);
			state.nowcastBulletin = bulletin;
			setCachedWeatherState(state);
			logger.info("Boletim nowcast (Camada B) gerado", {
				source: bulletin.source,
			});
		}
	} catch (err) {
		logger.warn("Nowcast falhou ao integrar ao estado", {
			error: String(err),
		});
	}

	const now = Date.now();
	const bulletinAgeMs = existingBulletin
		? now - existingBulletin.generatedAt
		: Infinity;
	const isExpired = bulletinAgeMs > 900_000; // 15 min expiration
	const isRainStatusMismatch = Boolean(
		radar.hasRegionalRain &&
			existingBulletin &&
			(existingBulletin.bulletin.includes("estáveis") ||
				existingBulletin.bulletin.includes("sem instabilidades") ||
				existingBulletin.bulletin.includes("estável") ||
				existingBulletin.bulletin.includes("Nenhuma alteração")),
	);

	if (!existingBulletin || isExpired || isRainStatusMismatch) {
		logger.info("Triggering fresh AI Weather Bulletin generation", {
			reason: !existingBulletin
				? "no_bulletin"
				: isRainStatusMismatch
					? "rain_status_mismatch"
					: "cache_expired",
			bulletinAgeMin: Math.round(bulletinAgeMs / 60000),
			hasRegionalRain: radar.hasRegionalRain,
		});
		const newBulletinText = await generateAiWeatherBulletin(
			state,
			lastUnifiedReport,
		);
		const updatedBulletin = await getLatestWeatherBulletin();
		state.bulletin = updatedBulletin || {
			bulletin: newBulletinText,
			source: "heuristic",
			generatedAt: now,
		};
		setCachedWeatherState(state);
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

async function getReqJson(req: IncomingRequest): Promise<unknown> {
	if (!req) return {};
	if (req.body && typeof req.body === "object") return req.body;
	if (typeof req.json === "function") {
		return await req.json().catch(() => ({}));
	}
	return {};
}

export async function handleRequest(reqIn: IncomingRequest | string): Promise<Response> {
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
		return new Response(null, {
			status: 204,
			headers: {
				"Access-Control-Allow-Origin": "*",
				"Access-Control-Allow-Methods": "GET, POST, OPTIONS, HEAD",
				"Access-Control-Allow-Headers": "Content-Type, Authorization",
			},
		});
	}

	// Serve llms.txt endpoints without rate limits
	if (path === "/llms.txt" || path === "/llms-full.txt") {
		let state = getCachedWeatherState();
		if (!state) state = await syncWeatherCycle();
		const text = renderLlmsTxt(state, lastUnifiedReport);
		return new Response(text, {
			headers: {
				"Content-Type": "text/plain; charset=utf-8",
				"Cache-Control": "public, max-age=300",
			},
		});
	}

	// Rate limit all /api/* endpoints except /health
	if (path.startsWith("/api/")) {
		const ip =
			getHeader(req, "x-forwarded-for")?.split(",")[0]?.trim() ||
			getHeader(req, "x-real-ip") ||
			"unknown";
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

	try {
		if (path === "/health" || path === "/health/") return handleHealth();
		if (path === "/api/status") return handleStatus();
		if (path === "/api/services" || path === "/api/report") {
			if (!lastUnifiedReport) await runChecks();
			return handleServices();
		}
		if (path === "/api/weather" || path === "/api/weather/radar") {
			let state = getCachedWeatherState();
			if (!state) state = await syncWeatherCycle();
			return Response.json(
				state || { error: "Sem dados climatológicos no momento" },
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
			return Response.json({
				bulletin: state?.bulletin || null,
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
			await runChecks();
			return Response.json({ status: "ok", timestamp: Date.now() });
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
				await runChecks();
				return Response.json({ status: "ok", report, timestamp: Date.now() });
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				return new Response(JSON.stringify({ error: msg }), {
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
				const ip =
					getHeader(req, "x-forwarded-for")?.split(",")[0]?.trim() ||
					getHeader(req, "x-real-ip") ||
					"127.0.0.1";
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
				await runChecks();

				return Response.json({
					status: "ok",
					isp,
					timestamp: Date.now(),
				});
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				return new Response(JSON.stringify({ error: msg }), {
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
		logger.error("API error", { path, error: msg });
		return new Response(JSON.stringify({ error: msg }), {
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
		for (const r of op.portalResults) savePortalResult(r);
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
	weatherInterval = setInterval(syncWeatherCycle, 900_000);
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
