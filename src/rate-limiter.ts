const WINDOW_MS = 60_000;
const MAX_REQUESTS = 10;

interface Bucket {
	count: number;
	resetAt: number;
}

const buckets = new Map<string, Bucket>();

setInterval(() => {
	const now = Date.now();
	for (const [key, bucket] of buckets) {
		if (now >= bucket.resetAt) buckets.delete(key);
	}
}, 30_000);

export function checkRateLimit(ip: string): {
	allowed: boolean;
	retryAfter: number;
} {
	return checkRateLimitScope(ip, MAX_REQUESTS, "default");
}

/**
 * Rate limit por escopo (ex: "track" 120/min, "admin" 20/min) — chaves
 * separadas, então a telemetria e o painel não consomem a cota do site.
 */
export function checkRateLimitScope(
	ip: string,
	maxRequests: number,
	scope: string,
): { allowed: boolean; retryAfter: number } {
	const now = Date.now();
	const key = `${scope}:${ip}`;
	let bucket = buckets.get(key);

	if (!bucket || now >= bucket.resetAt) {
		bucket = { count: 0, resetAt: now + WINDOW_MS };
		buckets.set(key, bucket);
	}

	bucket.count++;

	if (bucket.count > maxRequests) {
		const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
		return { allowed: false, retryAfter };
	}

	return { allowed: true, retryAfter: 0 };
}

/**
 * Limite com contador COMPARTILHADO no Turso — para os escopos que importam
 * (login, cron, llms*).
 *
 * Por quê: no serverless, o Map acima é POR INSTÂNCIA. Medido em produção em
 * 26/09/2026 — 30 GET paralelos em /api/stats passaram TODOS (teto 10/min) e
 * 10 de 12 tentativas de login paralelas passaram (teto 5/min). O UPSERT com
 * `RETURNING` é atômico no SQLite, então o contador vale para todas as
 * instâncias. Falha do banco cai no Map local (mais fraco — nunca aberto) e
 * avisa no log.
 */
let tabelaOk: Promise<unknown> | null = null;

export async function checkRateLimitShared(
	ip: string,
	maxRequests: number,
	scope: string,
	windowMs: number = WINDOW_MS,
): Promise<{ allowed: boolean; retryAfter: number }> {
	try {
		const { getDbClient } = await import("./db.js");
		const db = await getDbClient();
		if (!tabelaOk) {
			tabelaOk = db
				.execute(
					`CREATE TABLE IF NOT EXISTS rate_limit_counters (
						scope TEXT NOT NULL,
						key TEXT NOT NULL,
						win INTEGER NOT NULL,
						count INTEGER NOT NULL,
						PRIMARY KEY (scope, key)
					)`,
				)
				.catch((err: unknown) => {
					tabelaOk = null;
					throw err;
				});
		}
		await tabelaOk;

		const win = Math.floor(Date.now() / windowMs);
		const res = await db.execute({
			sql: `INSERT INTO rate_limit_counters (scope, key, win, count) VALUES (?, ?, ?, 1)
            ON CONFLICT(scope, key) DO UPDATE SET
              count = CASE WHEN rate_limit_counters.win = excluded.win
                           THEN rate_limit_counters.count + 1 ELSE 1 END,
              win = excluded.win
            RETURNING count`,
			args: [scope, ip, win],
		});
		const n = Number(res.rows[0]?.count ?? 1);

		// Faxina oportunista (1 em 50 chamadas) — a tabela é minúscula, mas
		// linha de janela antiga não serve para nada.
		if (Math.random() < 0.02) {
			await db
				.execute({
					sql: "DELETE FROM rate_limit_counters WHERE win < ?",
					args: [win - 60],
				})
				.catch(() => {});
		}

		if (n > maxRequests) {
			return {
				allowed: false,
				retryAfter: Math.max(
					1,
					Math.ceil(((win + 1) * windowMs - Date.now()) / 1000),
				),
			};
		}
		return { allowed: true, retryAfter: 0 };
	} catch (err: unknown) {
		console.warn(
			"[rate-limit] contador compartilhado indisponível, usando memória:",
			err instanceof Error ? err.message : err,
		);
		return checkRateLimitScope(ip, maxRequests, scope);
	}
}
