import { Database } from "bun:sqlite";
import { logger } from "./logger";
import type { BgpResult, ConnectivityResult, PortalResult } from "./types";

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

	logger.info("Database initialized", { path });
	return db;
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
	return db
		.query(
			`SELECT operator, host, success, latency_ms as latencyMs, error, timestamp
       FROM portal_results
       ORDER BY timestamp DESC
       LIMIT ?`,
		)
		.all(limit) as PortalResult[];
}

export function getLatestConnectivityResults(limit = 50): ConnectivityResult[] {
	return db
		.query(
			`SELECT label, host, success, latency_ms as latencyMs, error, timestamp
       FROM connectivity_results
       ORDER BY timestamp DESC
       LIMIT ?`,
		)
		.all(limit) as ConnectivityResult[];
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
	return db
		.query(
			`SELECT operator, host, success, latency_ms as latencyMs, error, timestamp
       FROM portal_results
       WHERE operator = ?
       ORDER BY timestamp DESC
       LIMIT ?`,
		)
		.all(operator, limit) as PortalResult[];
}

export function closeDb(): void {
	if (db) db.close();
}
