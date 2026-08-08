import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createClient as createWebClient, type Client } from "@libsql/client/web";
import { logger } from "./logger";
import type {
	BgpResult,
	ConnectivityResult,
	LocalSignalReport,
	OperatorName,
	PortalResult,
	WeatherBulletin,
	WeatherRadarData,
} from "./types";

let client: Client | null = null;

export async function getDbClient(): Promise<Client> {
	if (!client) {
		const tursoUrl = process.env.TURSO_DATABASE_URL || process.env.TURSO_URL;
		const tursoToken = process.env.TURSO_AUTH_TOKEN || process.env.TURSO_DATABASE_TOKEN || process.env.TURSO_AUTH_KEY;

		if (!tursoUrl) {
			throw new Error("TURSO_DATABASE_URL or TURSO_URL environment variable is required");
		}
		if (!tursoToken) {
			throw new Error("TURSO_AUTH_TOKEN, TURSO_DATABASE_TOKEN or TURSO_AUTH_KEY environment variable is required");
		}

		logger.info("Connecting to Turso Cloud SQLite database via Web Client", { url: tursoUrl });
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
		await db.batch([
			`CREATE TABLE IF NOT EXISTS portal_results (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				operator TEXT NOT NULL,
				host TEXT NOT NULL,
				success INTEGER NOT NULL,
				latency_ms REAL NOT NULL,
				error TEXT DEFAULT '',
				timestamp INTEGER NOT NULL
			)`,
			`CREATE TABLE IF NOT EXISTS connectivity_results (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				label TEXT NOT NULL,
				host TEXT NOT NULL,
				success INTEGER NOT NULL,
				latency_ms REAL NOT NULL,
				error TEXT DEFAULT '',
				timestamp INTEGER NOT NULL
			)`,
			`CREATE TABLE IF NOT EXISTS bgp_results (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				operator TEXT NOT NULL,
				asn INTEGER NOT NULL,
				prefix_count_v4 INTEGER NOT NULL,
				prefix_count_v6 INTEGER NOT NULL,
				timestamp INTEGER NOT NULL,
				error TEXT DEFAULT ''
			)`,
			`CREATE TABLE IF NOT EXISTS known_events (
				source TEXT NOT NULL,
				hash TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				PRIMARY KEY (source, hash)
			)`,
			`CREATE TABLE IF NOT EXISTS signal_reports (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				operator TEXT NOT NULL,
				status TEXT NOT NULL,
				signal_type TEXT NOT NULL,
				notes TEXT DEFAULT '',
				reported_at INTEGER NOT NULL,
				expires_at INTEGER NOT NULL
			)`,
			`CREATE TABLE IF NOT EXISTS ip_isp_cache (
				ip TEXT PRIMARY KEY,
				operator TEXT,
				isp_name TEXT NOT NULL,
				asn TEXT DEFAULT '',
				is_mobile INTEGER NOT NULL DEFAULT 0,
				cached_at INTEGER NOT NULL
			)`,
			`CREATE TABLE IF NOT EXISTS telemetry_logs (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				ip TEXT NOT NULL,
				operator TEXT,
				isp_name TEXT NOT NULL,
				rtt_ms REAL NOT NULL,
				effective_type TEXT DEFAULT '',
				timestamp INTEGER NOT NULL
			)`,
			`CREATE TABLE IF NOT EXISTS isp_health_states (
				isp_name TEXT PRIMARY KEY,
				operator TEXT,
				status TEXT NOT NULL,
				avg_rtt_ms REAL NOT NULL,
				sample_count INTEGER NOT NULL,
				degraded_count INTEGER NOT NULL,
				details TEXT NOT NULL,
				last_updated INTEGER NOT NULL,
				expires_at INTEGER NOT NULL
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
			"CREATE INDEX IF NOT EXISTS idx_portal_timestamp ON portal_results(timestamp)",
			"CREATE INDEX IF NOT EXISTS idx_connectivity_timestamp ON connectivity_results(timestamp)",
			"CREATE INDEX IF NOT EXISTS idx_bgp_timestamp ON bgp_results(timestamp)",
			"CREATE INDEX IF NOT EXISTS idx_known_events_source ON known_events(source)",
			"CREATE INDEX IF NOT EXISTS idx_signal_reports_expires ON signal_reports(expires_at)",
			"CREATE INDEX IF NOT EXISTS idx_telemetry_timestamp ON telemetry_logs(timestamp)",
			"CREATE INDEX IF NOT EXISTS idx_event_history_timestamp ON event_history(timestamp)",
			"CREATE INDEX IF NOT EXISTS idx_weather_bulletins_generated ON weather_bulletins(generated_at)",
		], "write");

		logger.info("Database schema initialized successfully via LibSQL Web batch");
	} catch (err) {
		logger.error("Failed to initialize Database schema", { error: String(err) });
	}

	return db;
}

export async function getCachedIspInfo(ip: string): Promise<{
	ip: string;
	operator: OperatorName | null;
	ispName: string;
	asn: string;
	isMobile: boolean;
} | null> {
	const db = await getDbClient();
	const now = Date.now();
	const res = await db.execute({
		sql: "SELECT ip, operator, isp_name as ispName, asn, is_mobile as isMobile FROM ip_isp_cache WHERE ip = ? AND cached_at > ?",
		args: [ip, now - 7 * 86400 * 1000],
	});

	if (res.rows.length === 0) return null;
	const row = res.rows[0] as any;

	return {
		ip: String(row.ip),
		operator: row.operator ? (row.operator as OperatorName) : null,
		ispName: String(row.ispName),
		asn: String(row.asn ?? ""),
		isMobile: Boolean(row.isMobile),
	};
}

export async function saveCachedIspInfo(
	ip: string,
	operator: OperatorName | null,
	ispName: string,
	asn: string,
	isMobile: boolean,
): Promise<void> {
	const db = await getDbClient();
	await db.execute({
		sql: "INSERT OR REPLACE INTO ip_isp_cache (ip, operator, isp_name, asn, is_mobile, cached_at) VALUES (?, ?, ?, ?, ?, ?)",
		args: [ip, operator, ispName, asn, isMobile ? 1 : 0, Date.now()],
	});
}

export async function saveTelemetryLog(
	ip: string,
	operator: OperatorName | null,
	ispName: string,
	rttMs: number,
	effectiveType: string,
): Promise<void> {
	const db = await getDbClient();
	await db.execute({
		sql: "INSERT INTO telemetry_logs (ip, operator, isp_name, rtt_ms, effective_type, timestamp) VALUES (?, ?, ?, ?, ?, ?)",
		args: [ip, operator, ispName, rttMs, effectiveType, Date.now()],
	});

	await recalculateIspHealth(ispName, operator);
}

export interface IspHealthState {
	ispName: string;
	operator: OperatorName | null;
	status: "ok" | "warn" | "critical";
	avgRttMs: number;
	sampleCount: number;
	degradedCount: number;
	details: string;
	lastUpdated: number;
	expiresAt: number;
}

export async function recalculateIspHealth(
	ispName: string,
	operator: OperatorName | null,
	ttlHours = 2,
): Promise<IspHealthState> {
	const db = await getDbClient();
	const now = Date.now();
	const cutoff = now - 60 * 60 * 1000;
	const res = await db.execute({
		sql: `SELECT 
        COUNT(DISTINCT ip) as sample_count,
        AVG(rtt_ms) as avg_rtt,
        SUM(CASE WHEN rtt_ms > 100 OR effective_type IN ('3g', '2g', 'slow-2g') THEN 1 ELSE 0 END) as degraded_count
       FROM telemetry_logs
       WHERE (isp_name = ? OR (operator IS NOT NULL AND operator = ?)) AND timestamp > ?`,
		args: [ispName, operator ?? "", cutoff],
	});

	const row = res.rows[0] as any;
	const sampleCount = Number(row?.sample_count || 1);
	const avgRttMs = Math.round(Number(row?.avg_rtt || 0));
	const degradedCount = Number(row?.degraded_count || 0);

	let status: "ok" | "warn" | "critical" = "ok";
	let details = `🟢 Conexão estável (Latência média: ${avgRttMs}ms — ${sampleCount} morador(es) em Ipiranga)`;

	if (avgRttMs > 200) {
		status = "critical";
		details = `🔴 Instabilidade severa na rede móvel (${avgRttMs}ms)`;
	} else if (avgRttMs > 100 || degradedCount > 0) {
		status = "warn";
		details = `⚠️ Latência elevada (${avgRttMs}ms)`;
	}

	const expiresAt = now + ttlHours * 3600 * 1000;
	const targetKey = operator || ispName;

	await db.execute({
		sql: `INSERT OR REPLACE INTO isp_health_states 
     (isp_name, operator, status, avg_rtt_ms, sample_count, degraded_count, details, last_updated, expires_at) 
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		args: [
			targetKey,
			operator,
			status,
			avgRttMs,
			sampleCount,
			degradedCount,
			details,
			now,
			expiresAt,
		],
	});

	return {
		ispName: targetKey,
		operator,
		status,
		avgRttMs,
		sampleCount,
		degradedCount,
		details,
		lastUpdated: now,
		expiresAt,
	};
}

export async function getActiveIspHealthStates(): Promise<IspHealthState[]> {
	const db = await getDbClient();
	const now = Date.now();
	const res = await db.execute({
		sql: `SELECT isp_name as ispName, operator, status, avg_rtt_ms as avgRttMs, 
              sample_count as sampleCount, degraded_count as degradedCount, 
              details, last_updated as lastUpdated, expires_at as expiresAt
       FROM isp_health_states
       WHERE expires_at > ?
       ORDER BY last_updated DESC`,
		args: [now],
	});

	return res.rows.map((r: any) => ({
		ispName: String(r.ispName),
		operator: r.operator ? (r.operator as OperatorName) : null,
		status: r.status as "ok" | "warn" | "critical",
		avgRttMs: Number(r.avgRttMs),
		sampleCount: Number(r.sampleCount),
		degradedCount: Number(r.degradedCount),
		details: String(r.details),
		lastUpdated: Number(r.lastUpdated),
		expiresAt: Number(r.expiresAt),
	}));
}

export interface TelemetrySummary {
	operator: OperatorName | "Outros";
	userCount: number;
	avgRttMs: number;
	degradedCount: number;
}

export async function getTelemetryStats(windowMinutes = 30): Promise<TelemetrySummary[]> {
	const db = await getDbClient();
	const cutoff = Date.now() - windowMinutes * 60 * 1000;
	const res = await db.execute({
		sql: `SELECT 
        COALESCE(operator, 'Outros') as op,
        COUNT(DISTINCT ip) as user_count,
        AVG(rtt_ms) as avg_rtt,
        SUM(CASE WHEN rtt_ms > 250 OR effective_type IN ('3g', '2g', 'slow-2g') THEN 1 ELSE 0 END) as degraded_count
       FROM telemetry_logs
       WHERE timestamp > ?
       GROUP BY op`,
		args: [cutoff],
	});

	return res.rows.map((r: any) => ({
		operator: r.op as OperatorName | "Outros",
		userCount: Number(r.user_count),
		avgRttMs: Math.round(Number(r.avg_rtt || 0)),
		degradedCount: Number(r.degraded_count),
	}));
}

export async function saveSignalReport(
	operator: OperatorName,
	status: "ok" | "degraded" | "down",
	signalType: string,
	notes = "",
	ttlHours = 3,
): Promise<LocalSignalReport> {
	const db = await getDbClient();
	const now = Date.now();
	const expiresAt = now + ttlHours * 3600 * 1000;

	if (status === "ok") {
		await db.execute({
			sql: "UPDATE signal_reports SET expires_at = ? WHERE operator = ? AND expires_at > ?",
			args: [now, operator, now],
		});
	}

	await db.execute({
		sql: "INSERT INTO signal_reports (operator, status, signal_type, notes, reported_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
		args: [operator, status, signalType, notes, now, expiresAt],
	});

	return {
		operator,
		status,
		signalType,
		notes,
		reportedAt: now,
		expiresAt,
	};
}

export async function getActiveSignalReports(): Promise<LocalSignalReport[]> {
	const db = await getDbClient();
	const now = Date.now();
	const res = await db.execute({
		sql: `SELECT id, operator, status, signal_type as signalType, notes, reported_at as reportedAt, expires_at as expiresAt
       FROM signal_reports
       WHERE expires_at > ?
       ORDER BY reported_at DESC`,
		args: [now],
	});

	return res.rows.map((r: any) => ({
		operator: r.operator as OperatorName,
		status: r.status as "ok" | "degraded" | "down",
		signalType: String(r.signalType),
		notes: String(r.notes ?? ""),
		reportedAt: Number(r.reportedAt),
		expiresAt: Number(r.expiresAt),
	}));
}

export async function savePortalResult(r: PortalResult): Promise<void> {
	const db = await getDbClient();
	await db.execute({
		sql: "INSERT INTO portal_results (operator, host, success, latency_ms, error, timestamp) VALUES (?, ?, ?, ?, ?, ?)",
		args: [r.operator, r.host, r.success ? 1 : 0, r.latencyMs, r.error, r.timestamp],
	});
}

export async function saveConnectivityResult(r: ConnectivityResult): Promise<void> {
	const db = await getDbClient();
	await db.execute({
		sql: "INSERT INTO connectivity_results (label, host, success, latency_ms, error, timestamp) VALUES (?, ?, ?, ?, ?, ?)",
		args: [r.label, r.host, r.success ? 1 : 0, r.latencyMs, r.error, r.timestamp],
	});
}

export async function saveBgpResult(r: BgpResult): Promise<void> {
	const db = await getDbClient();
	await db.execute({
		sql: "INSERT INTO bgp_results (operator, asn, prefix_count_v4, prefix_count_v6, timestamp, error) VALUES (?, ?, ?, ?, ?, ?)",
		args: [r.operator, r.asn, r.prefixCountV4, r.prefixCountV6, r.timestamp, r.error ?? ""],
	});
}

export async function getLatestPortalResults(limit = 50): Promise<PortalResult[]> {
	const db = await getDbClient();
	const res = await db.execute({
		sql: `SELECT operator, host, success, latency_ms as latencyMs, error, timestamp
       FROM portal_results
       ORDER BY timestamp DESC
       LIMIT ?`,
		args: [limit],
	});

	return res.rows.map((r: any) => ({
		operator: r.operator as OperatorName,
		host: String(r.host),
		success: Boolean(r.success),
		latencyMs: Number(r.latencyMs),
		error: String(r.error ?? ""),
		timestamp: Number(r.timestamp),
	}));
}

export async function getLatestConnectivityResults(limit = 50): Promise<ConnectivityResult[]> {
	const db = await getDbClient();
	const res = await db.execute({
		sql: `SELECT label, host, success, latency_ms as latencyMs, error, timestamp
       FROM connectivity_results
       ORDER BY timestamp DESC
       LIMIT ?`,
		args: [limit],
	});

	return res.rows.map((r: any) => ({
		label: String(r.label),
		host: String(r.host),
		success: Boolean(r.success),
		latencyMs: Number(r.latencyMs),
		error: String(r.error ?? ""),
		timestamp: Number(r.timestamp),
	}));
}

export async function getLatestBgpResults(limit = 50): Promise<BgpResult[]> {
	const db = await getDbClient();
	const res = await db.execute({
		sql: `SELECT operator, asn, prefix_count_v4 as prefixCountV4, prefix_count_v6 as prefixCountV6, timestamp, error
       FROM bgp_results
       ORDER BY timestamp DESC
       LIMIT ?`,
		args: [limit],
	});

	return res.rows.map((r: any) => ({
		operator: r.operator as OperatorName,
		asn: Number(r.asn),
		prefixCountV4: Number(r.prefixCountV4),
		prefixCountV6: Number(r.prefixCountV6),
		samplePrefixes: [],
		timestamp: Number(r.timestamp),
		error: r.error ? String(r.error) : undefined,
	}));
}

export async function getPortalHistory(
	operator: string,
	limit = 100,
): Promise<PortalResult[]> {
	const db = await getDbClient();
	const res = await db.execute({
		sql: `SELECT operator, host, success, latency_ms as latencyMs, error, timestamp
       FROM portal_results
       WHERE operator = ?
       ORDER BY timestamp DESC
       LIMIT ?`,
		args: [operator, limit],
	});

	return res.rows.map((r: any) => ({
		operator: r.operator as OperatorName,
		host: String(r.host),
		success: Boolean(r.success),
		latencyMs: Number(r.latencyMs),
		error: String(r.error ?? ""),
		timestamp: Number(r.timestamp),
	}));
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
	const copelTodayRow = copelTodayRes.rows[0] as any;

	const copel7DaysRes = await db.execute({
		sql: "SELECT COUNT(*) as cnt FROM event_history WHERE source = 'copel' AND timestamp >= ?",
		args: [startOf7Days],
	});
	const copel7DaysRow = copel7DaysRes.rows[0] as any;

	const saneparTodayRes = await db.execute({
		sql: "SELECT COUNT(*) as cnt FROM event_history WHERE source = 'sanepar' AND timestamp >= ?",
		args: [startOfDay],
	});
	const saneparTodayRow = saneparTodayRes.rows[0] as any;

	const sanepar7DaysRes = await db.execute({
		sql: "SELECT COUNT(*) as cnt FROM event_history WHERE source = 'sanepar' AND timestamp >= ?",
		args: [startOf7Days],
	});
	const sanepar7DaysRow = sanepar7DaysRes.rows[0] as any;

	const telemetryTodayRes = await db.execute({
		sql: "SELECT COUNT(*) as cnt FROM telemetry_logs WHERE timestamp >= ?",
		args: [startOfDay],
	});
	const telemetryTodayRow = telemetryTodayRes.rows[0] as any;

	const logsRes = await db.execute("SELECT id, source, title, bairro, details, consumers, timestamp FROM event_history ORDER BY timestamp DESC LIMIT 30");

	const recentLogs: EventLogItem[] = logsRes.rows.map((r: any) => ({
		id: Number(r.id),
		source: String(r.source),
		title: String(r.title),
		bairro: String(r.bairro ?? ""),
		details: String(r.details ?? ""),
		consumers: Number(r.consumers ?? 0),
		timestamp: Number(r.timestamp),
	}));

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
	const res = await db.execute("SELECT payload, status, last_success_time FROM weather_radar_cache ORDER BY timestamp DESC LIMIT 1");
	if (res.rows.length === 0) return null;
	const row = res.rows[0] as any;

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
	const res = await db.execute("SELECT id, bulletin, source, generated_at as generatedAt FROM weather_bulletins ORDER BY generated_at DESC LIMIT 1");
	if (res.rows.length === 0) return null;
	const row = res.rows[0] as any;

	return {
		id: Number(row.id),
		bulletin: String(row.bulletin),
		source: row.source as "nvidia_nim" | "gemini" | "heuristic",
		generatedAt: Number(row.generatedAt),
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
