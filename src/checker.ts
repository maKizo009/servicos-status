import type { AppConfig } from "./config";
import { connectivityTargets } from "./config";
import { checkBgpPrefixes } from "./probes/bgp";
import { checkConnectivity } from "./probes/connectivity";
import { checkCopel } from "./probes/copel";
import { checkPortal } from "./probes/portal";
import { checkSanepar } from "./probes/sanepar";
import type { EventTracker } from "./state";
import type {
	BgpResult,
	ConnectivityResult,
	CopelOutage,
	OperatorName,
	PortalResult,
	SaneparInterruption,
	ServiceHealth,
	UnifiedReport,
} from "./types";

export interface AllCheckData {
	operators: {
		name: OperatorName;
		portalResults: PortalResult[];
		connectivityResults: ConnectivityResult[];
		bgpResult: BgpResult;
	}[];
	newCopelOutages: CopelOutage[];
	newSaneparInterruptions: SaneparInterruption[];
	timestamp: number;
}

export async function runAllChecks(
	config: AppConfig,
	tracker: EventTracker,
): Promise<AllCheckData> {
	const timestamp = Date.now();
	const operatorResults: AllCheckData["operators"] = [];

	for (const [opName, opCfg] of Object.entries(config.operators) as [
		OperatorName,
		{ asn: number; portals: string[] },
	][]) {
		const portalResults = await Promise.all(
			opCfg.portals.map((host) =>
				checkPortal(host, opName, config.portalTimeoutMs),
			),
		);

		const connectivityResults = await Promise.all(
			connectivityTargets.map((t) =>
				checkConnectivity(t.host, t.label, config.connectivityTimeoutMs),
			),
		);

		const bgpResult = await checkBgpPrefixes(
			opCfg.asn,
			opName,
			config.bgpTimeoutMs,
		);

		operatorResults.push({
			name: opName,
			portalResults,
			connectivityResults,
			bgpResult,
		});
	}

	const newCopelOutages = config.municipio
		? await checkCopel(
				config.copelApiUrl,
				config.municipio,
				config.copelTimeoutMs,
				tracker,
			)
		: [];

	const newSaneparInterruptions = config.municipio
		? await checkSanepar(
				config.saneparViewsAjaxUrl,
				config.saneparPageUrl,
				config.saneparViewName,
				config.saneparDisplays,
				30_000,
				config.municipio,
				tracker,
			)
		: [];

	return {
		operators: operatorResults,
		newCopelOutages,
		newSaneparInterruptions,
		timestamp,
	};
}

function assessOperatorLevel(
	portals: PortalResult[],
	connectivity: ConnectivityResult[],
	bgp: BgpResult | null,
	latencyWarnMs = 2000,
): "ok" | "warn" | "critical" {
	const portalFailures = portals.filter((p) => !p.success).length;
	const connFailures = connectivity.filter((c) => !c.success).length;

	if (portalFailures > 0 || connFailures > 0 || bgp?.error) return "critical";

	const highLatency =
		portals.some((p) => p.latencyMs > latencyWarnMs && p.success) ||
		connectivity.some((c) => c.latencyMs > latencyWarnMs && c.success);
	if (highLatency) return "warn";

	return "ok";
}

export function buildUnifiedReport(
	data: AllCheckData,
	latencyWarnMs = 2000,
): UnifiedReport {
	const services: ServiceHealth[] = [];

	for (const op of data.operators) {
		const status = assessOperatorLevel(
			op.portalResults,
			op.connectivityResults,
			op.bgpResult,
			latencyWarnMs,
		);
		const failures = op.portalResults.filter((p) => !p.success).length;
		const details =
			status === "ok"
				? "OK"
				: status === "critical"
					? `${failures} portal(is) fora do ar`
					: "Latência alta detectada";

		services.push({
			name: op.name,
			category: "telecom",
			status,
			details,
			timestamp: data.timestamp,
			data: {
				portalResults: op.portalResults,
				connectivityResults: op.connectivityResults,
				bgp: op.bgpResult,
			},
		});
	}

	const copelStatus = data.newCopelOutages.length > 0 ? "critical" : "ok";
	services.push({
		name: "Copel",
		category: "utility",
		status: copelStatus,
		details:
			copelStatus === "ok"
				? "Sem ocorrências"
				: `${data.newCopelOutages.length} ocorrência(s)`,
		timestamp: data.timestamp,
		data: { newEvents: data.newCopelOutages },
	});

	const saneparStatus =
		data.newSaneparInterruptions.length > 0 ? "critical" : "ok";
	services.push({
		name: "Sanepar",
		category: "utility",
		status: saneparStatus,
		details:
			saneparStatus === "ok"
				? "Sem interrupções"
				: `${data.newSaneparInterruptions.length} interrupção(ões)`,
		timestamp: data.timestamp,
		data: { newEvents: data.newSaneparInterruptions },
	});

	const allStatuses = services.map((s) => s.status);
	const overallStatus: "ok" | "warn" | "critical" = allStatuses.includes(
		"critical",
	)
		? "critical"
		: allStatuses.includes("warn")
			? "warn"
			: "ok";

	return {
		generatedAt: data.timestamp,
		overallStatus,
		services,
		newEvents: {
			copel: data.newCopelOutages,
			sanepar: data.newSaneparInterruptions,
		},
	};
}
