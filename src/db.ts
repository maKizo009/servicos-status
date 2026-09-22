import {
	type Client,
	createClient as createWebClient,
} from "@libsql/client/web";
import { logger } from "./logger.js";
import type {
	WeatherBulletin,
	WeatherRadarData,
} from "./types.js";

let client: Client | null = null;

export async function getDbClient(): Promise<Client> {
	if (!client) {
		const tursoUrl =
			process.env.TURSO_DATABASE_URL ||
			process.env.TURSO_URL ||
			"libsql://health-lucasmodesto.aws-us-east-2.turso.io";
		const tursoToken =
			process.env.TURSO_AUTH_TOKEN ||
			process.env.TURSO_DATABASE_TOKEN ||
			process.env.TURSO_AUTH_KEY;

		logger.info("Connecting to Turso Cloud SQLite database via Web Client", {
			url: tursoUrl,
		});
		client = createWebClient({
			url: tursoUrl,
			authToken: tursoToken,
		});
	}
	return client;
}

export async function initDb(): Promise<Client> {
	const db = await getDbClient();

	try {
		await db.batch(
			[
				`CREATE TABLE IF NOT EXISTS known_events (
				source TEXT NOT NULL,
				hash TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				PRIMARY KEY (source, hash)
			)`,
				`CREATE TABLE IF NOT EXISTS event_history (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				source TEXT NOT NULL,
				title TEXT NOT NULL,
				bairro TEXT DEFAULT '',
				details TEXT DEFAULT '',
				consumers INTEGER DEFAULT 0,
				timestamp INTEGER NOT NULL
			)`,
				`CREATE TABLE IF NOT EXISTS weather_radar_cache (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				host TEXT NOT NULL,
				version TEXT NOT NULL,
				payload TEXT NOT NULL,
				status TEXT NOT NULL,
				last_success_time INTEGER NOT NULL,
				timestamp INTEGER NOT NULL
			)`,
				`CREATE TABLE IF NOT EXISTS weather_bulletins (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				bulletin TEXT NOT NULL,
				source TEXT NOT NULL,
				generated_at INTEGER NOT NULL
			)`,
				`CREATE TABLE IF NOT EXISTS weather_nowcast_bulletins (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					text TEXT NOT NULL,
					source TEXT NOT NULL,
					generated_at INTEGER NOT NULL,
					context_key TEXT
				)`,
				`CREATE TABLE IF NOT EXISTS weather_state_cache (
				id INTEGER PRIMARY KEY CHECK (id = 1),
				payload TEXT NOT NULL,
				updated_at INTEGER NOT NULL
			)`,
				`CREATE TABLE IF NOT EXISTS push_subscriptions (
				endpoint TEXT PRIMARY KEY,
				p256dh TEXT NOT NULL,
				auth TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				last_seen_at INTEGER NOT NULL
			)`,
				`CREATE TABLE IF NOT EXISTS push_sent (
				evento TEXT PRIMARY KEY,
				enviado_at INTEGER NOT NULL
			)`,
				`CREATE TABLE IF NOT EXISTS app_events (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				tipo TEXT NOT NULL,
				session_id TEXT,
				ts INTEGER NOT NULL
			)`,
				// Dedup de instalação: 1 evento 'install' por dispositivo (session_id).
				// Sem isso, cada abertura do app em modo standalone contava +1 install
				// (achado 2026-08-12 — número de instalações inflado no painel).
				// ATENÇÃO (21/09/2026): o índice único abaixo FALHA se o banco já tiver
				// installs duplicados de antes de 12/08 — e como isto roda em batch, a
				// falha derrubava o init INTEIRO do schema ("Failed to initialize
				// Database schema", SQLITE_CONSTRAINT UNIQUE app_events.session_id).
				// Limpar antes, mantendo o install MAIS ANTIGO de cada sessão. É
				// idempotente: sem duplicados o DELETE não apaga nada.
				`DELETE FROM app_events
				WHERE tipo = 'install' AND session_id IS NOT NULL
				  AND id NOT IN (
					SELECT MIN(id) FROM app_events
					WHERE tipo = 'install' AND session_id IS NOT NULL
					GROUP BY session_id
				  )`,
				`CREATE UNIQUE INDEX IF NOT EXISTS idx_app_events_install_once
				ON app_events(session_id) WHERE tipo='install'`,
				`CREATE TABLE IF NOT EXISTS app_sessions (
				session_id TEXT PRIMARY KEY,
				first_seen INTEGER NOT NULL,
				last_seen INTEGER NOT NULL
			)`,
				`CREATE TABLE IF NOT EXISTS webauthn_credentials (
				id TEXT PRIMARY KEY,
				public_key TEXT NOT NULL,
				counter INTEGER NOT NULL DEFAULT 0,
				transports TEXT DEFAULT '[]',
				created_at INTEGER NOT NULL
			)`,
				`CREATE TABLE IF NOT EXISTS webauthn_challenges (
				challenge TEXT PRIMARY KEY,
				email TEXT NOT NULL,
				purpose TEXT NOT NULL,
				ts INTEGER NOT NULL
			)`,
				"CREATE INDEX IF NOT EXISTS idx_connectivity_timestamp ON connectivity_results(timestamp)",
				"CREATE INDEX IF NOT EXISTS idx_bgp_timestamp ON bgp_results(timestamp)",
				"CREATE INDEX IF NOT EXISTS idx_known_events_source ON known_events(source)",
				"CREATE INDEX IF NOT EXISTS idx_signal_reports_expires ON signal_reports(expires_at)",
				"CREATE INDEX IF NOT EXISTS idx_event_history_timestamp ON event_history(timestamp)",
				"CREATE INDEX IF NOT EXISTS idx_weather_bulletins_generated ON weather_bulletins(generated_at)",
				"CREATE INDEX IF NOT EXISTS idx_weather_nowcast_bulletins_generated ON weather_nowcast_bulletins(generated_at)",
				"CREATE INDEX IF NOT EXISTS idx_app_events_ts ON app_events(ts)",
				"CREATE INDEX IF NOT EXISTS idx_app_events_tipo ON app_events(tipo)",
				"CREATE INDEX IF NOT EXISTS idx_app_sessions_last_seen ON app_sessions(last_seen)",
			],
			"write",
		);

		// Migração idempotente (22/09/2026): bancos criados antes desta data não têm
		// a coluna context_key. Ela é a impressão do CENÁRIO do boletim — sem ela o
		// gate de reuso volta a comparar só tempo, e o texto congelava com timestamp
		// novo a cada ciclo (ver llm-bulletin.ts e o incidente do "Boletim IA").
		try {
			await db.execute(
				"ALTER TABLE weather_nowcast_bulletins ADD COLUMN context_key TEXT",
			);
		} catch {
			// coluna já existe — caminho normal nas execuções seguintes
		}

		logger.info(
			"Database schema initialized successfully via LibSQL Web batch",
		);
	} catch (err) {
		logger.error("Failed to initialize Database schema", {
			error: String(err),
		});
	}

	return db;
}


export interface EventLogItem {
	id: number;
	source: string;
	title: string;
	bairro: string;
	details: string;
	consumers: number;
	timestamp: number;
}

export async function saveEventLog(
	source: string,
	title: string,
	bairro = "",
	details = "",
	consumers = 0,
): Promise<void> {
	const db = await getDbClient();
	await db.execute({
		sql: "INSERT INTO event_history (source, title, bairro, details, consumers, timestamp) VALUES (?, ?, ?, ?, ?, ?)",
		args: [source, title, bairro, details, consumers, Date.now()],
	});
}

export async function getDailyStatsSummary() {
	const db = await getDbClient();
	const now = Date.now();
	const startOfDay = now - (now % (24 * 60 * 60 * 1000));
	const startOf7Days = now - 7 * 86400 * 1000;

	const copelTodayRes = await db.execute({
		sql: "SELECT COUNT(*) as cnt, COALESCE(SUM(consumers), 0) as totalConsumers FROM event_history WHERE source = 'copel' AND timestamp >= ?",
		args: [startOfDay],
	});
	const copelTodayRow = copelTodayRes.rows[0] as Record<string, unknown>;

	const copel7DaysRes = await db.execute({
		sql: "SELECT COUNT(*) as cnt FROM event_history WHERE source = 'copel' AND timestamp >= ?",
		args: [startOf7Days],
	});
	const copel7DaysRow = copel7DaysRes.rows[0] as Record<string, unknown>;

	const saneparTodayRes = await db.execute({
		sql: "SELECT COUNT(*) as cnt FROM event_history WHERE source = 'sanepar' AND timestamp >= ?",
		args: [startOfDay],
	});
	const saneparTodayRow = saneparTodayRes.rows[0] as Record<string, unknown>;

	const sanepar7DaysRes = await db.execute({
		sql: "SELECT COUNT(*) as cnt FROM event_history WHERE source = 'sanepar' AND timestamp >= ?",
		args: [startOf7Days],
	});
	const sanepar7DaysRow = sanepar7DaysRes.rows[0] as Record<string, unknown>;

	const telemetryTodayRes = await db.execute({
		sql: "SELECT COUNT(*) as cnt FROM telemetry_logs WHERE timestamp >= ?",
		args: [startOfDay],
	});
	const telemetryTodayRow = telemetryTodayRes.rows[0] as Record<
		string,
		unknown
	>;

	const logsRes = await db.execute(
		"SELECT id, source, title, bairro, details, consumers, timestamp FROM event_history ORDER BY timestamp DESC LIMIT 30",
	);

	const recentLogs: EventLogItem[] = logsRes.rows.map(
		(r: Record<string, unknown>) => ({
			id: Number(r.id),
			source: String(r.source),
			title: String(r.title),
			bairro: String(r.bairro ?? ""),
			details: String(r.details ?? ""),
			consumers: Number(r.consumers ?? 0),
			timestamp: Number(r.timestamp),
		}),
	);

	return {
		todayStart: startOfDay,
		copel: {
			eventsToday: Number(copelTodayRow?.cnt || 0),
			totalConsumersToday: Number(copelTodayRow?.totalConsumers || 0),
			events7Days: Number(copel7DaysRow?.cnt || 0),
		},
		sanepar: {
			eventsToday: Number(saneparTodayRow?.cnt || 0),
			events7Days: Number(sanepar7DaysRow?.cnt || 0),
		},
		telemetry: {
			testsToday: Number(telemetryTodayRow?.cnt || 0),
		},
		recentLogs,
	};
}

export async function saveRadarCache(data: WeatherRadarData): Promise<void> {
	const db = await getDbClient();
	const payload = JSON.stringify(data);
	await db.execute({
		sql: "INSERT INTO weather_radar_cache (host, version, payload, status, last_success_time, timestamp) VALUES (?, ?, ?, ?, ?, ?)",
		args: [
			data.host,
			data.version,
			payload,
			data.status,
			data.lastSuccessTime,
			Date.now(),
		],
	});
}

export async function getLatestRadarCache(): Promise<WeatherRadarData | null> {
	const db = await getDbClient();
	const res = await db.execute(
		"SELECT payload, status, last_success_time FROM weather_radar_cache ORDER BY timestamp DESC LIMIT 1",
	);
	if (res.rows.length === 0) return null;
	const row = res.rows[0] as Record<string, unknown>;

	try {
		const parsed = JSON.parse(String(row.payload)) as WeatherRadarData;
		parsed.status = String(row.status) as "ok" | "degraded" | "down";
		parsed.lastSuccessTime = Number(row.last_success_time);
		return parsed;
	} catch {
		return null;
	}
}

export async function saveWeatherBulletin(
	bulletin: string,
	source: "nvidia_nim" | "gemini" | "heuristic",
): Promise<WeatherBulletin> {
	const now = Date.now();
	const db = await getDbClient();
	const res = await db.execute({
		sql: "INSERT INTO weather_bulletins (bulletin, source, generated_at) VALUES (?, ?, ?)",
		args: [bulletin, source, now],
	});
	return {
		id: Number(res.lastInsertRowid ?? Date.now()),
		bulletin,
		source,
		generatedAt: now,
	};
}

export async function getLatestWeatherBulletin(): Promise<WeatherBulletin | null> {
	const db = await getDbClient();
	const res = await db.execute(
		"SELECT id, bulletin, source, generated_at as generatedAt FROM weather_bulletins ORDER BY generated_at DESC LIMIT 1",
	);
	if (res.rows.length === 0) return null;
	const row = res.rows[0] as Record<string, unknown>;

	return {
		id: Number(row.id),
		bulletin: String(row.bulletin),
		source: row.source as "nvidia_nim" | "gemini" | "heuristic",
		generatedAt: Number(row.generatedAt),
	};
}

export interface NowcastBulletinRecord {
	id: number;
	text: string;
	source:
		| "opencode_vision"
		| "gemini"
		| "nvidia_nim_vision"
		| "heuristic"
		| "openrouter"
		| "nvidia_nim";
	generatedAt: number;
	/** Impressão do cenário que gerou o texto (null em boletins antigos). */
	contextKey?: string | null;
}

export async function saveNowcastBulletin(
	text: string,
	source:
		| "opencode_vision"
		| "gemini"
		| "nvidia_nim_vision"
		| "heuristic"
		| "openrouter"
		| "nvidia_nim",
	contextKey?: string | null,
): Promise<NowcastBulletinRecord> {
	const now = Date.now();
	const db = await getDbClient();
	const res = await db.execute({
		sql: "INSERT INTO weather_nowcast_bulletins (text, source, generated_at, context_key) VALUES (?, ?, ?, ?)",
		args: [text, source, now, contextKey ?? null],
	});
	return {
		id: Number(res.lastInsertRowid ?? now),
		text,
		source,
		generatedAt: now,
		contextKey: contextKey ?? null,
	};
}

export async function getLatestNowcastBulletin(): Promise<NowcastBulletinRecord | null> {
	const db = await getDbClient();
	const res = await db.execute(
		"SELECT id, text, source, generated_at as generatedAt, context_key as contextKey FROM weather_nowcast_bulletins ORDER BY generated_at DESC LIMIT 1",
	);
	if (res.rows.length === 0) return null;
	const row = res.rows[0] as Record<string, unknown>;

	return {
		id: Number(row.id),
		text: String(row.text),
		source: row.source as
			| "opencode_vision"
			| "nvidia_nim_vision"
			| "gemini"
			| "heuristic"
			| "openrouter"
			| "nvidia_nim",
		generatedAt: Number(row.generatedAt),
		contextKey: row.contextKey == null ? null : String(row.contextKey),
	};
}

export interface WeatherStateCacheRecord {
	payload: string;
	updatedAt: number;
}

/**
 * Persiste o WeatherState completo (JSON) no Turso — o cache compartilhado
 * entre instâncias serverless. O cron (/api/cron) grava a cada 10 min; os
 * endpoints /api/weather e /llms.txt leem daqui SEM regenerar o ciclo VLM
 * inline (achado 2026-08-15: instância fria rodava o sync completo e o
 * visitante esperava 60s+).
 */
export async function saveWeatherStateCache(payload: string): Promise<void> {
	const db = await getDbClient();
	await db.execute({
		sql: "INSERT INTO weather_state_cache (id, payload, updated_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at",
		args: [payload, Date.now()],
	});
}

export async function getWeatherStateCache(): Promise<WeatherStateCacheRecord | null> {
	const db = await getDbClient();
	const res = await db.execute(
		"SELECT payload, updated_at as updatedAt FROM weather_state_cache WHERE id = 1",
	);
	if (res.rows.length === 0) return null;
	const row = res.rows[0] as Record<string, unknown>;
	return {
		payload: String(row.payload),
		updatedAt: Number(row.updatedAt),
	};
}

export function closeDb(): void {
	if (client) {
		try {
			client.close();
		} catch {}
		client = null;
	}
}
