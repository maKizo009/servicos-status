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

	logger.info("Database initialized", { path });
	return db;
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

export function closeDb(): void {
	if (db) db.close();
}
