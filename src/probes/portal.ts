import type { OperatorName, PortalResult } from "../types";

const DEFAULT_HEADERS = {
	"User-Agent":
		"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
	Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
};

export async function checkPortal(
	host: string,
	operator: OperatorName,
	timeoutMs: number,
): Promise<PortalResult> {
	const start = performance.now();
	const timestamp = Date.now();

	try {
		const response = await fetch(`https://${host}`, {
			signal: AbortSignal.timeout(timeoutMs),
			redirect: "follow",
			headers: DEFAULT_HEADERS,
		});
		const latencyMs = performance.now() - start;
		const isSuccess = response.status < 500;
		return {
			operator,
			host,
			success: isSuccess,
			latencyMs,
			error: isSuccess ? "" : `HTTP ${response.status} ${response.statusText}`,
			timestamp,
		};
	} catch (err: unknown) {
		const latencyMs = performance.now() - start;
		const msg = err instanceof Error ? err.message : String(err);
		if (msg.includes("SSL") || msg.includes("certificate")) {
			try {
				const response = await fetch(`http://${host}`, {
					signal: AbortSignal.timeout(timeoutMs),
					redirect: "follow",
					headers: DEFAULT_HEADERS,
				});
				const retryLatency = performance.now() - start;
				const isSuccess = response.status < 500;
				return {
					operator,
					host,
					success: isSuccess,
					latencyMs: retryLatency,
					error: isSuccess
						? ""
						: `HTTP ${response.status} ${response.statusText}`,
					timestamp,
				};
			} catch {
				return {
					operator,
					host,
					success: false,
					latencyMs,
					error: `SSL fallback failed: ${msg}`,
					timestamp,
				};
			}
		}
		if (
			msg.includes("dns") ||
			msg.includes("getaddrinfo") ||
			msg.includes("ENOTFOUND")
		) {
			return {
				operator,
				host,
				success: false,
				latencyMs: 0,
				error: `DNS fail: ${msg}`,
				timestamp,
			};
		}
		if (msg.includes("timeout") || msg.includes("timed out")) {
			return {
				operator,
				host,
				success: false,
				latencyMs: timeoutMs,
				error: "Timeout",
				timestamp,
			};
		}
		return { operator, host, success: false, latencyMs, error: msg, timestamp };
	}
}
