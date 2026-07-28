import type {
	BgpResult,
	ConnectivityResult,
	OperatorName,
	PortalResult,
} from "./types";

export interface WorkerInput {
	type: "run_checks";
	operator: OperatorName;
	asn: number;
	portals: string[];
	connectivityTargets: { host: string; label: string }[];
	portalTimeoutMs: number;
	connectivityTimeoutMs: number;
	bgpTimeoutMs: number;
}

export interface WorkerOutput {
	operator: OperatorName;
	portalResults: PortalResult[];
	connectivityResults: ConnectivityResult[];
	bgpResult: BgpResult;
	timestamp: number;
}

self.onmessage = async (event: MessageEvent<WorkerInput>) => {
	const input = event.data;
	const timestamp = Date.now();

	const portalResults = await Promise.all(
		input.portals.map((host) =>
			fetch(`https://${host}`, {
				signal: AbortSignal.timeout(input.portalTimeoutMs),
				redirect: "follow",
				headers: {
					"User-Agent":
						"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
				},
			})
				.then((r) => {
					const isSuccess = r.status < 500;
					return {
						operator: input.operator,
						host,
						success: isSuccess,
						latencyMs: 0,
						error: isSuccess ? "" : `HTTP ${r.status} ${r.statusText}`,
						timestamp,
						actualLatency: performance.now(),
					};
				})
				.catch((err: Error) => ({
					operator: input.operator,
					host,
					success: false,
					latencyMs: input.portalTimeoutMs,
					error: err.message,
					timestamp,
					actualLatency: performance.now(),
				})),
		),
	);

	const connectivityResults = await Promise.all(
		input.connectivityTargets.map((t) =>
			fetch(`https://${t.host}`, {
				method: "HEAD",
				signal: AbortSignal.timeout(input.connectivityTimeoutMs),
				headers: {
					"User-Agent":
						"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
				},
			})
				.then((r) => {
					const isSuccess = r.status < 500;
					return {
						label: t.label,
						host: t.host,
						success: isSuccess,
						latencyMs: 0,
						error: isSuccess ? "" : `HTTP ${r.status} ${r.statusText}`,
						timestamp,
						actualLatency: performance.now(),
					};
				})
				.catch((err: Error) => ({
					label: t.label,
					host: t.host,
					success: false,
					latencyMs: input.connectivityTimeoutMs,
					error: err.message,
					timestamp,
					actualLatency: performance.now(),
				})),
		),
	);

	let bgpResult: BgpResult;
	try {
		const url = `https://stat.ripe.net/data/announced-prefixes/data.json?resource=AS${input.asn}`;
		const res = await fetch(url, {
			signal: AbortSignal.timeout(input.bgpTimeoutMs),
		});
		const data = (await res.json()) as {
			data?: { prefixes?: { prefix: string }[] };
		};
		const prefixes = data?.data?.prefixes ?? [];
		const v4 = prefixes.filter((p) => !p.prefix.includes(":"));
		const v6 = prefixes.filter((p) => p.prefix.includes(":"));
		bgpResult = {
			operator: input.operator,
			asn: input.asn,
			prefixCountV4: v4.length,
			prefixCountV6: v6.length,
			samplePrefixes: v4.slice(0, 10).map((p) => p.prefix),
			timestamp,
		};
	} catch (err: unknown) {
		bgpResult = {
			operator: input.operator,
			asn: input.asn,
			prefixCountV4: 0,
			prefixCountV6: 0,
			samplePrefixes: [],
			timestamp,
			error: err instanceof Error ? err.message : String(err),
		};
	}

	const output: WorkerOutput = {
		operator: input.operator,
		portalResults: portalResults.map((r: Record<string, unknown>) => ({
			operator: r.operator as OperatorName,
			host: r.host as string,
			success: r.success as boolean,
			latencyMs: r.latencyMs as number,
			error: r.error as string,
			timestamp: r.timestamp as number,
		})),
		connectivityResults: connectivityResults.map(
			(r: Record<string, unknown>) => ({
				label: r.label as string,
				host: r.host as string,
				success: r.success as boolean,
				latencyMs: r.latencyMs as number,
				error: r.error as string,
				timestamp: r.timestamp as number,
			}),
		),
		bgpResult,
		timestamp,
	};

	self.postMessage(output);
};
