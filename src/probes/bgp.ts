import type { BgpResult, OperatorName } from "../types";

export async function checkBgpPrefixes(
	asn: number,
	operator: OperatorName,
	timeoutMs: number,
): Promise<BgpResult> {
	const timestamp = Date.now();

	try {
		const url = `https://stat.ripe.net/data/announced-prefixes/data.json?resource=AS${asn}`;
		const response = await fetch(url, {
			signal: AbortSignal.timeout(timeoutMs),
		});

		if (!response.ok) {
			return {
				operator,
				asn,
				prefixCountV4: 0,
				prefixCountV6: 0,
				samplePrefixes: [],
				timestamp,
				error: `RIPE API returned ${response.status}`,
			};
		}

		const data = (await response.json()) as {
			data?: { prefixes?: { prefix: string }[] };
		};
		const prefixes = data?.data?.prefixes ?? [];
		const v4 = prefixes.filter((p) => !p.prefix.includes(":"));
		const v6 = prefixes.filter((p) => p.prefix.includes(":"));

		return {
			operator,
			asn,
			prefixCountV4: v4.length,
			prefixCountV6: v6.length,
			samplePrefixes: v4.slice(0, 10).map((p) => p.prefix),
			timestamp,
		};
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		return {
			operator,
			asn,
			prefixCountV4: 0,
			prefixCountV6: 0,
			samplePrefixes: [],
			timestamp,
			error: msg,
		};
	}
}
