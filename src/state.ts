import { createHash } from "node:crypto";
import { getDbClient } from "./db";
import { logger } from "./logger";

export function makeHash(...parts: string[]): string {
	return createHash("md5").update(parts.join("|")).digest("hex").slice(0, 16);
}

export class EventTracker {
	private known: Map<string, Set<string>>;

	constructor() {
		this.known = new Map();
		this.load();
	}

	private async load(): Promise<void> {
		try {
			const db = getDbClient();
			const res = await db.execute("SELECT source, hash FROM known_events");
			for (const row of res.rows) {
				const source = String(row.source);
				const hash = String(row.hash);
				let set = this.known.get(source);
				if (!set) {
					set = new Set();
					this.known.set(source, set);
				}
				set.add(hash);
			}
			logger.info("EventTracker loaded", { total: res.rows.length });
		} catch (err) {
			logger.warn("EventTracker load failed", { error: String(err) });
		}
	}

	isKnown(source: string, hash: string): boolean {
		const set = this.known.get(source);
		return set ? set.has(hash) : false;
	}

	async markKnown(source: string, hash: string): Promise<void> {
		let set = this.known.get(source);
		if (!set) {
			set = new Set();
			this.known.set(source, set);
		}
		if (set.has(hash)) return;
		set.add(hash);
		try {
			const db = getDbClient();
			await db.execute({
				sql: "INSERT INTO known_events (source, hash, created_at) VALUES (?, ?, ?)",
				args: [source, hash, Date.now()],
			});
		} catch {}
	}
}
