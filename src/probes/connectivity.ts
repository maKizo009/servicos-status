import type { ConnectivityResult, ProbeStatus } from "../types.js";

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

	const ok = (latencyMs: number, error = ""): ConnectivityResult => ({
		label,
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
	): ConnectivityResult => ({
		label,
		host,
		success: false,
		latencyMs,
		error,
		timestamp,
		probeStatus,
	});

	try {
		const response = await fetch(`https://${host}`, {
			method: "HEAD",
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
		if (msg.includes("timeout") || msg.includes("timed out")) {
			return fail(timeoutMs, "Timeout", "timeout");
		}
		return fail(latencyMs, msg);
	}
}
