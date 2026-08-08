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
	const now = Date.now();
	let bucket = buckets.get(ip);

	if (!bucket || now >= bucket.resetAt) {
		bucket = { count: 0, resetAt: now + WINDOW_MS };
		buckets.set(ip, bucket);
	}

	bucket.count++;

	if (bucket.count > MAX_REQUESTS) {
		const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
		return { allowed: false, retryAfter };
	}

	return { allowed: true, retryAfter: 0 };
}
