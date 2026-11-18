import { createHash } from "node:crypto";
import { getDbClient } from "./db.js";
import { logger } from "./logger.js";

export function makeHash(...parts: string[]): string {
	return createHash("md5").update(parts.join("|")).digest("hex").slice(0, 16);
}

export class EventTracker {
	private known: Map<string, Set<string>>;
	private isInit = false;

	constructor() {
		this.known = new Map();
	}

	async init(): Promise<void> {
		if (this.isInit) return;
		try {
			const db = await getDbClient();
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
		this.isInit = true;
	}

	async migrateCopelSnapshot(): Promise<void> {
		try {
			const db = await getDbClient();
			const snapshot = await db.execute("SELECT payload FROM services_snapshot WHERE id = 1");
			const report = snapshot.rows[0]?.payload ? JSON.parse(String(snapshot.rows[0].payload)) : null;
			const copel = report?.services?.find((s: { name?: string }) => s.name === "Copel");
			for (const outage of copel?.data?.activeEvents ?? []) {
				const id = outage.idOcorrencia || outage.numeroSequencial;
				const hash = id ? makeHash(id) : makeHash(outage.municipio || "", outage.bairro || "", outage.dataInicio || "");
				if (!this.isKnown("copel_id", hash)) await this.markKnown("copel_id", hash);
			}
		} catch (error) {
			logger.warn("Migração do retrato Copel indisponível", { error: String(error) });
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
			const db = await getDbClient();
			await db.execute({
				sql: "INSERT INTO known_events (source, hash, created_at) VALUES (?, ?, ?)",
				args: [source, hash, Date.now()],
			});
		} catch (error) {
			logger.warn("Falha ao persistir ocorrência conhecida", { source, error: String(error) });
		}
	}
}
