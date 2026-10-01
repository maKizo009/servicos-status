/**
 * Entrypoint do Monitor Ipiranga (01/10/2026).
 *
 * Só o que é bootstrap: servidor HTTP, agendadores e shutdown. O router vive
 * em `src/router/`, o ciclo de clima em `src/sync-weather.ts`. Pensado para
 * uso agêntico: este arquivo não precisa ser lido para mexer em rota ou no
 * ciclo de clima — cada um tem seu módulo.
 *
 * Re-exporta o que `api/` consome (`api/index.ts` e `api/cron.ts` importam
 * daqui por compatibilidade — podem passar a importar direto dos módulos).
 */
import { runAllChecks } from "./checker.js";
import { loadConfig } from "./config.js";
import { closeDb } from "./db.js";
import { logger } from "./logger.js";
import {
	sendCopelAlert,
	sendSaneparAlert,
} from "./telegram.js";
import {
	ensureInitialized,
	getTracker,
} from "./runtime-state.js";
import {
	handleRequest,
	runChecks,
} from "./router/index.js";
import type { IncomingRequest } from "./http-helpers.js";
import { syncWeatherCycle } from "./sync-weather.js";

export { handleRequest } from "./router/index.js";
export { syncWeatherCycle } from "./sync-weather.js";
export { ensureInitialized } from "./runtime-state.js";

const config = loadConfig();
const startTime = Date.now();
let checkInterval: ReturnType<typeof setInterval> | null = null;
let weatherInterval: ReturnType<typeof setInterval> | null = null;
let server: { stop: () => void } | null = null;

async function runOnce(): Promise<void> {
	await ensureInitialized();
	logger.info("Running single check cycle (--once)");

	const data = await runAllChecks(config, getTracker());

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
