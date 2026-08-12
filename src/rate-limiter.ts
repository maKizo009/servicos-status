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
