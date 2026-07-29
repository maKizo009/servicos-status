import type { ConnectivityResult } from "../types";

const DEFAULT_HEADERS = {
	"User-Agent":
		"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
};

export async function checkConnectivity(
	host: string,
	label: string,
	timeoutMs: number,
): Promise<ConnectivityResult> {
	const start = performance.now();
	const timestamp = Date.now();

	try {
		const response = await fetch(`https://${host}`, {
			method: "HEAD",
			signal: AbortSignal.timeout(timeoutMs),
			redirect: "manual",
			headers: DEFAULT_HEADERS,
		});
		const latencyMs = performance.now() - start;
		const isSuccess = response.status < 500;
		return {
			label,
			host,
			success: isSuccess,
			latencyMs,
			error: isSuccess ? "" : `HTTP ${response.status} ${response.statusText}`,
			timestamp,
		};
	} catch (err: unknown) {
		const latencyMs = performance.now() - start;
		const msg = err instanceof Error ? err.message : String(err);
		if (msg.includes("timeout") || msg.includes("timed out")) {
			return {
				label,
				host,
				success: false,
				latencyMs: timeoutMs,
				error: "Timeout",
				timestamp,
			};
		}
		return { label, host, success: false, latencyMs, error: msg, timestamp };
	}
}
