import type { PortalResult, ProbeStatus } from "../types.js";

const DEFAULT_HEADERS = {
	"User-Agent":
		"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
	Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
};

export async function checkPortal(
	host: string,
	operator: PortalResult["operator"],
	timeoutMs: number,
): Promise<PortalResult> {
	const start = performance.now();
	const timestamp = Date.now();

	const ok = (latencyMs: number, error = ""): PortalResult => ({
		operator,
		host,
		success: true,
		latencyMs,
		error,
		timestamp,
		probeStatus: "ok" satisfies ProbeStatus,
	});

	const fail = (
		latencyMs: number,
		error: string,
		probeStatus: ProbeStatus = "failure",
	): PortalResult => ({
		operator,
		host,
		success: false,
		latencyMs,
		error,
		timestamp,
		probeStatus,
	});

	try {
		const response = await fetch(`https://${host}`, {
			signal: AbortSignal.timeout(timeoutMs),
			redirect: "manual",
			headers: DEFAULT_HEADERS,
		});
		const latencyMs = performance.now() - start;
		const isSuccess = response.status < 500;
		return isSuccess
			? ok(latencyMs)
			: fail(latencyMs, `HTTP ${response.status} ${response.statusText}`);
	} catch (err: unknown) {
		const latencyMs = performance.now() - start;
		const msg = err instanceof Error ? err.message : String(err);
		if (msg.includes("SSL") || msg.includes("certificate")) {
			try {
				const response = await fetch(`http://${host}`, {
					signal: AbortSignal.timeout(timeoutMs),
					redirect: "manual",
					headers: DEFAULT_HEADERS,
				});
				const retryLatency = performance.now() - start;
				const isSuccess = response.status < 500;
				return isSuccess
					? ok(retryLatency)
					: fail(
							retryLatency,
							`HTTP ${response.status} ${response.statusText}`,
						);
			} catch {
				return fail(latencyMs, `SSL fallback failed: ${msg}`);
			}
		}
		if (
			msg.includes("dns") ||
			msg.includes("getaddrinfo") ||
			msg.includes("ENOTFOUND")
		) {
			return fail(0, `DNS fail: ${msg}`);
		}
		if (msg.includes("timeout") || msg.includes("timed out")) {
			// Timeout é indeterminado (Achado 4): pode ser o serviço OU o
			// monitor/rede. assessLevel() decide o peso com base no controle
			// de conectividade + debounce.
			return fail(timeoutMs, "Timeout", "timeout");
		}
		return fail(latencyMs, msg);
	}
}
