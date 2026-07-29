import { Database } from "bun:sqlite";
import { logger } from "./logger";
import type {
	BgpResult,
	ConnectivityResult,
	LocalSignalReport,
	OperatorName,
	PortalResult,
} from "./types";

let db: Database;

export function initDb(path = "data/health.db"): Database {
	db = new Database(path);
	db.run("PRAGMA journal_mode = WAL");
	db.run("PRAGMA synchronous = NORMAL");

	db.run(`
    CREATE TABLE IF NOT EXISTS portal_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      operator TEXT NOT NULL,
      host TEXT NOT NULL,
      success INTEGER NOT NULL,
      latency_ms REAL NOT NULL,
      error TEXT DEFAULT '',
      timestamp INTEGER NOT NULL
    )
  `);

	db.run(`
    CREATE TABLE IF NOT EXISTS connectivity_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      label TEXT NOT NULL,
      host TEXT NOT NULL,
      success INTEGER NOT NULL,
      latency_ms REAL NOT NULL,
      error TEXT DEFAULT '',
      timestamp INTEGER NOT NULL
    )
  `);

	db.run(`
    CREATE TABLE IF NOT EXISTS bgp_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      operator TEXT NOT NULL,
      asn INTEGER NOT NULL,
      prefix_count_v4 INTEGER NOT NULL,
      prefix_count_v6 INTEGER NOT NULL,
      timestamp INTEGER NOT NULL,
      error TEXT DEFAULT ''
    )
  `);

	db.run(`
    CREATE TABLE IF NOT EXISTS known_events (
      source TEXT NOT NULL,
      hash TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (source, hash)
    )
  `);

	db.run(`
    CREATE TABLE IF NOT EXISTS signal_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      operator TEXT NOT NULL,
      status TEXT NOT NULL,
      signal_type TEXT NOT NULL,
      notes TEXT DEFAULT '',
      reported_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    )
  `);

	db.run(`
    CREATE TABLE IF NOT EXISTS ip_isp_cache (
      ip TEXT PRIMARY KEY,
      operator TEXT,
      isp_name TEXT NOT NULL,
      asn TEXT DEFAULT '',
      is_mobile INTEGER NOT NULL DEFAULT 0,
      cached_at INTEGER NOT NULL
    )
  `);

	db.run(`
    CREATE TABLE IF NOT EXISTS telemetry_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ip TEXT NOT NULL,
      operator TEXT,
      isp_name TEXT NOT NULL,
      rtt_ms REAL NOT NULL,
      effective_type TEXT DEFAULT '',
      timestamp INTEGER NOT NULL
    )
  `);

	db.run(`
    CREATE TABLE IF NOT EXISTS isp_health_states (
      isp_name TEXT PRIMARY KEY,
      operator TEXT,
      status TEXT NOT NULL,
      avg_rtt_ms REAL NOT NULL,
      sample_count INTEGER NOT NULL,
      degraded_count INTEGER NOT NULL,
      details TEXT NOT NULL,
      last_updated INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    )
  `);

	db.run(`
    CREATE TABLE IF NOT EXISTS event_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      title TEXT NOT NULL,
      bairro TEXT DEFAULT '',
      details TEXT DEFAULT '',
      consumers INTEGER DEFAULT 0,
      timestamp INTEGER NOT NULL
    )
  `);

	db.run(`
    CREATE INDEX IF NOT EXISTS idx_portal_timestamp ON portal_results(timestamp)
  `);
	db.run(`
    CREATE INDEX IF NOT EXISTS idx_connectivity_timestamp ON connectivity_results(timestamp)
  `);
	db.run(`
    CREATE INDEX IF NOT EXISTS idx_bgp_timestamp ON bgp_results(timestamp)
  `);
	db.run(`
    CREATE INDEX IF NOT EXISTS idx_known_events_source ON known_events(source)
  `);
	db.run(`
    CREATE INDEX IF NOT EXISTS idx_signal_reports_expires ON signal_reports(expires_at)
  `);
	db.run(`
    CREATE INDEX IF NOT EXISTS idx_telemetry_timestamp ON telemetry_logs(timestamp)
  `);
	db.run(`
    CREATE INDEX IF NOT EXISTS idx_event_history_timestamp ON event_history(timestamp)
  `);

	logger.info("Database initialized", { path });
	return db;
}

export function getCachedIspInfo(ip: string): {
	ip: string;
	operator: OperatorName | null;
	ispName: string;
	asn: string;
	isMobile: boolean;
} | null {
	const now = Date.now();
	// Cache valid for 7 days
	const row = db
		.query(
			"SELECT ip, operator, isp_name as ispName, asn, is_mobile as isMobile FROM ip_isp_cache WHERE ip = ? AND cached_at > ?",
		)
		.get(ip, now - 7 * 86400 * 1000) as {
		ip: string;
		operator: OperatorName | null;
		ispName: string;
		asn: string;
		isMobile: number;
	} | null;

	if (!row) return null;
	return {
		...row,
		isMobile: Boolean(row.isMobile),
	};
}

export function saveCachedIspInfo(
	ip: string,
	operator: OperatorName | null,
	ispName: string,
	asn: string,
	isMobile: boolean,
): void {
	db.run(
		"INSERT OR REPLACE INTO ip_isp_cache (ip, operator, isp_name, asn, is_mobile, cached_at) VALUES (?, ?, ?, ?, ?, ?)",
		[ip, operator, ispName, asn, isMobile ? 1 : 0, Date.now()],
	);
}

export function saveTelemetryLog(
	ip: string,
	operator: OperatorName | null,
	ispName: string,
	rttMs: number,
	effectiveType: string,
): void {
	db.run(
		"INSERT INTO telemetry_logs (ip, operator, isp_name, rtt_ms, effective_type, timestamp) VALUES (?, ?, ?, ?, ?, ?)",
		[ip, operator, ispName, rttMs, effectiveType, Date.now()],
	);

	// Automatically update persistent ISP status
	recalculateIspHealth(ispName, operator);
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

export function recalculateIspHealth(
	ispName: string,
	operator: OperatorName | null,
	ttlHours = 2,
): IspHealthState {
	const now = Date.now();
	const cutoff = now - 60 * 60 * 1000;
	const row = db
		.query(
			`SELECT 
        COUNT(DISTINCT ip) as sample_count,
        AVG(rtt_ms) as avg_rtt,
        SUM(CASE WHEN rtt_ms > 100 OR effective_type IN ('3g', '2g', 'slow-2g') THEN 1 ELSE 0 END) as degraded_count
       FROM telemetry_logs
       WHERE (isp_name = ? OR (operator IS NOT NULL AND operator = ?)) AND timestamp > ?`,
		)
		.get(ispName, operator ?? "", cutoff) as {
		sample_count: number;
		avg_rtt: number;
		degraded_count: number;
	} | null;

	const sampleCount = row?.sample_count || 1;
	const avgRttMs = Math.round(row?.avg_rtt || 0);
	const degradedCount = row?.degraded_count || 0;

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

	db.run(
		`INSERT OR REPLACE INTO isp_health_states 
     (isp_name, operator, status, avg_rtt_ms, sample_count, degraded_count, details, last_updated, expires_at) 
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[
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
	);

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

export function getActiveIspHealthStates(): IspHealthState[] {
	const now = Date.now();
	return db
		.query(
			`SELECT isp_name as ispName, operator, status, avg_rtt_ms as avgRttMs, 
              sample_count as sampleCount, degraded_count as degradedCount, 
              details, last_updated as lastUpdated, expires_at as expiresAt
       FROM isp_health_states
       WHERE expires_at > ?
       ORDER BY last_updated DESC`,
		)
		.all(now) as IspHealthState[];
}

export interface TelemetrySummary {
	operator: OperatorName | "Outros";
	userCount: number;
	avgRttMs: number;
	degradedCount: number; // Users reporting 3g/2g or RTT > 250ms
}

export function getTelemetryStats(windowMinutes = 30): TelemetrySummary[] {
	const cutoff = Date.now() - windowMinutes * 60 * 1000;
	const rows = db
		.query(
			`SELECT 
        COALESCE(operator, 'Outros') as op,
        COUNT(DISTINCT ip) as user_count,
        AVG(rtt_ms) as avg_rtt,
        SUM(CASE WHEN rtt_ms > 250 OR effective_type IN ('3g', '2g', 'slow-2g') THEN 1 ELSE 0 END) as degraded_count
       FROM telemetry_logs
       WHERE timestamp > ?
       GROUP BY op`,
		)
		.all(cutoff) as {
		op: string;
		user_count: number;
		avg_rtt: number;
		degraded_count: number;
	}[];

	return rows.map((r) => ({
		operator: r.op as OperatorName | "Outros",
		userCount: r.user_count,
		avgRttMs: Math.round(r.avg_rtt || 0),
		degradedCount: r.degraded_count,
	}));
}

export function saveSignalReport(
	operator: OperatorName,
	status: "ok" | "degraded" | "down",
	signalType: string,
	notes = "",
	ttlHours = 3,
): LocalSignalReport {
	const now = Date.now();
	const expiresAt = now + ttlHours * 3600 * 1000;

	// Invalidate older reports for this operator if status is 'ok'
	if (status === "ok") {
		db.run(
			"UPDATE signal_reports SET expires_at = ? WHERE operator = ? AND expires_at > ?",
			[now, operator, now],
		);
	}

	db.run(
		"INSERT INTO signal_reports (operator, status, signal_type, notes, reported_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
		[operator, status, signalType, notes, now, expiresAt],
	);

	logger.info("Local signal report saved", {
		operator,
		status,
		signalType,
		notes,
		expiresAt,
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

export function getActiveSignalReports(): LocalSignalReport[] {
	const now = Date.now();
	return db
		.query(
			`SELECT id, operator, status, signal_type as signalType, notes, reported_at as reportedAt, expires_at as expiresAt
       FROM signal_reports
       WHERE expires_at > ?
       ORDER BY reported_at DESC`,
		)
		.all(now) as LocalSignalReport[];
}

export function savePortalResult(r: PortalResult): void {
	db.run(
		"INSERT INTO portal_results (operator, host, success, latency_ms, error, timestamp) VALUES (?, ?, ?, ?, ?, ?)",
		[r.operator, r.host, r.success ? 1 : 0, r.latencyMs, r.error, r.timestamp],
	);
}

export function saveConnectivityResult(r: ConnectivityResult): void {
	db.run(
		"INSERT INTO connectivity_results (label, host, success, latency_ms, error, timestamp) VALUES (?, ?, ?, ?, ?, ?)",
		[r.label, r.host, r.success ? 1 : 0, r.latencyMs, r.error, r.timestamp],
	);
}

export function saveBgpResult(r: BgpResult): void {
	db.run(
		"INSERT INTO bgp_results (operator, asn, prefix_count_v4, prefix_count_v6, timestamp, error) VALUES (?, ?, ?, ?, ?, ?)",
		[
			r.operator,
			r.asn,
			r.prefixCountV4,
			r.prefixCountV6,
			r.timestamp,
			r.error ?? "",
		],
	);
}

export function getLatestPortalResults(limit = 50): PortalResult[] {
	const rows = db
		.query(
			`SELECT operator, host, success, latency_ms as latencyMs, error, timestamp
       FROM portal_results
       ORDER BY timestamp DESC
       LIMIT ?`,
		)
		.all(limit) as (Omit<PortalResult, "success"> & { success: number })[];
	return rows.map((r) => ({ ...r, success: Boolean(r.success) }));
}

export function getLatestConnectivityResults(limit = 50): ConnectivityResult[] {
	const rows = db
		.query(
			`SELECT label, host, success, latency_ms as latencyMs, error, timestamp
       FROM connectivity_results
       ORDER BY timestamp DESC
       LIMIT ?`,
		)
		.all(limit) as (Omit<ConnectivityResult, "success"> & {
		success: number;
	})[];
	return rows.map((r) => ({ ...r, success: Boolean(r.success) }));
}

export function getLatestBgpResults(limit = 50): BgpResult[] {
	return db
		.query(
			`SELECT operator, asn, prefix_count_v4 as prefixCountV4, prefix_count_v6 as prefixCountV6, timestamp, error
       FROM bgp_results
       ORDER BY timestamp DESC
       LIMIT ?`,
		)
		.all(limit) as BgpResult[];
}

export function getPortalHistory(
	operator: string,
	limit = 100,
): PortalResult[] {
	const rows = db
		.query(
			`SELECT operator, host, success, latency_ms as latencyMs, error, timestamp
       FROM portal_results
       WHERE operator = ?
       ORDER BY timestamp DESC
       LIMIT ?`,
		)
		.all(operator, limit) as (Omit<PortalResult, "success"> & {
		success: number;
	})[];
	return rows.map((r) => ({ ...r, success: Boolean(r.success) }));
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

export function saveEventLog(
	source: string,
	title: string,
	bairro = "",
	details = "",
	consumers = 0,
): void {
	db.run(
		"INSERT INTO event_history (source, title, bairro, details, consumers, timestamp) VALUES (?, ?, ?, ?, ?, ?)",
		[source, title, bairro, details, consumers, Date.now()],
	);
}

export function getDailyStatsSummary() {
	const now = Date.now();
	const startOfDay = now - (now % (24 * 60 * 60 * 1000));
	const startOf7Days = now - 7 * 86400 * 1000;

	const copelToday = db
		.query(
			"SELECT COUNT(*) as cnt, COALESCE(SUM(consumers), 0) as totalConsumers FROM event_history WHERE source = 'copel' AND timestamp >= ?",
		)
		.get(startOfDay) as { cnt: number; totalConsumers: number } | null;

	const copel7Days = db
		.query(
			"SELECT COUNT(*) as cnt FROM event_history WHERE source = 'copel' AND timestamp >= ?",
		)
		.get(startOf7Days) as { cnt: number } | null;

	const saneparToday = db
		.query(
			"SELECT COUNT(*) as cnt FROM event_history WHERE source = 'sanepar' AND timestamp >= ?",
		)
		.get(startOfDay) as { cnt: number } | null;

	const sanepar7Days = db
		.query(
			"SELECT COUNT(*) as cnt FROM event_history WHERE source = 'sanepar' AND timestamp >= ?",
		)
		.get(startOf7Days) as { cnt: number } | null;

	const telemetryToday = db
		.query("SELECT COUNT(*) as cnt FROM telemetry_logs WHERE timestamp >= ?")
		.get(startOfDay) as { cnt: number } | null;

	const logs = db
		.query(
			"SELECT id, source, title, bairro, details, consumers, timestamp FROM event_history ORDER BY timestamp DESC LIMIT 30",
		)
		.all() as EventLogItem[];

	return {
		todayStart: startOfDay,
		copel: {
			eventsToday: copelToday?.cnt || 0,
			totalConsumersToday: copelToday?.totalConsumers || 0,
			events7Days: copel7Days?.cnt || 0,
		},
		sanepar: {
			eventsToday: saneparToday?.cnt || 0,
			events7Days: sanepar7Days?.cnt || 0,
		},
		telemetry: {
			testsToday: telemetryToday?.cnt || 0,
		},
		recentLogs: logs,
	};
}

export function closeDb(): void {
	if (db) db.close();
}
