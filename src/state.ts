import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { logger } from "./logger";

export function makeHash(...parts: string[]): string {
	return createHash("md5").update(parts.join("|")).digest("hex").slice(0, 16);
}

export class EventTracker {
	private known: Map<string, Set<string>>;
	private db: Database;

	constructor(db: Database) {
		this.db = db;
		this.known = new Map();
		this.load();
	}

	private load(): void {
		const rows = this.db
			.query("SELECT source, hash FROM known_events")
			.all() as { source: string; hash: string }[];
		for (const row of rows) {
			let set = this.known.get(row.source);
			if (!set) {
				set = new Set();
				this.known.set(row.source, set);
			}
			set.add(row.hash);
		}
		logger.info("EventTracker loaded", { total: rows.length });
	}

	isKnown(source: string, hash: string): boolean {
		const set = this.known.get(source);
		return set ? set.has(hash) : false;
	}

	markKnown(source: string, hash: string): void {
		let set = this.known.get(source);
		if (!set) {
			set = new Set();
			this.known.set(source, set);
		}
		if (set.has(hash)) return;
		set.add(hash);
		try {
			this.db.run(
				"INSERT INTO known_events (source, hash, created_at) VALUES (?, ?, ?)",
				[source, hash, Date.now()],
			);
		} catch {}
	}
}
