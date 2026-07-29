import type { AppConfig } from "./config";
import { connectivityTargets } from "./config";
import { getActiveSignalReports } from "./db";
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
	copelOutages: CopelOutage[];
	newCopelOutages: CopelOutage[];
	saneparInterruptions: SaneparInterruption[];
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

	const copelRes = config.municipio
		? await checkCopel(
				config.copelApiUrl,
				config.municipio,
				config.copelTimeoutMs,
				tracker,
			)
		: { allOutages: [], newOutages: [] };

	const saneparRes = config.municipio
		? await checkSanepar(
				config.saneparViewsAjaxUrl,
				config.saneparPageUrl,
				config.saneparViewName,
				config.saneparDisplays,
				30_000,
				config.municipio,
				tracker,
			)
		: { allInterruptions: [], newInterruptions: [] };

	return {
		operators: operatorResults,
		copelOutages: copelRes.allOutages,
		newCopelOutages: copelRes.newOutages,
		saneparInterruptions: saneparRes.allInterruptions,
		newSaneparInterruptions: saneparRes.newInterruptions,
		timestamp,
	};
}

export function assessLevel(
	portals: PortalResult[],
	connectivity: ConnectivityResult[],
	bgp: BgpResult | BgpResult[] | null,
	latencyWarnMs = 2000,
): "ok" | "warn" | "critical" {
	const portalFailures = portals.filter((p) => !p.success).length;
	const connFailures = connectivity.filter((c) => !c.success).length;
	const bgpList = Array.isArray(bgp) ? bgp : bgp ? [bgp] : [];
	const bgpZeroPrefixes = bgpList.some(
		(b) =>
			Boolean(b) &&
			!b.error &&
			b.prefixCountV4 === 0 &&
			b.prefixCountV6 === 0 &&
			b.asn > 0,
	);

	if (portalFailures > 0 || connFailures > 0 || bgpZeroPrefixes)
		return "critical";

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
	const signalReports = getActiveSignalReports();

	for (const op of data.operators) {
		let status = assessLevel(
			op.portalResults,
			op.connectivityResults,
			op.bgpResult,
			latencyWarnMs,
		);
		const portalFailures = op.portalResults.filter((p) => !p.success).length;
		const connFailures = op.connectivityResults.filter(
			(c) => !c.success,
		).length;
		const bgpFail =
			op.bgpResult &&
			!op.bgpResult.error &&
			op.bgpResult.prefixCountV4 === 0 &&
			op.bgpResult.prefixCountV6 === 0;

		const activeSignalReport = signalReports.find(
			(r) => r.operator === op.name && r.status !== "ok",
		);

		if (activeSignalReport) {
			if (activeSignalReport.status === "down") {
				status = "critical";
			} else if (status === "ok") {
				status = "warn";
			}
		}

		let details = "OK";
		if (activeSignalReport) {
			details = `⚠️ Sinal Local: ${activeSignalReport.signalType} (${activeSignalReport.notes || "Relato de instabilidade local"})`;
		} else if (status === "critical") {
			const parts: string[] = [];
			if (portalFailures > 0)
				parts.push(`${portalFailures} portal(is) fora do ar`);
			if (connFailures > 0)
				parts.push(`${connFailures} teste(s) de conectividade falharam`);
			if (bgpFail) parts.push("0 prefixos BGP anunciados");
			details = parts.join(", ") || "Falha de serviço";
		} else if (status === "warn") {
			details = "Latência alta detectada";
		}

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
				signalReport: activeSignalReport ?? null,
			},
		});
	}

	const copelStatus = data.copelOutages.length > 0 ? "critical" : "ok";
	const copelTotalConsumers = data.copelOutages.reduce(
		(sum, o) => sum + (o.qtdConsumidores || 0),
		0,
	);
	const cityTotalConsumers = 5200;
	const pctAffected = Number(
		((copelTotalConsumers / cityTotalConsumers) * 100).toFixed(2),
	);

	services.push({
		name: "Copel",
		category: "utility",
		status: copelStatus,
		details:
			copelStatus === "ok"
				? "Sem ocorrências"
				: copelTotalConsumers > 0
					? `${copelTotalConsumers} UCs sem energia em ${data.copelOutages.length} ocorrência(s)`
					: `${data.copelOutages.length} ocorrência(s)`,
		timestamp: data.timestamp,
		data: {
			activeEvents: data.copelOutages,
			newEvents: data.newCopelOutages,
			totalConsumers: copelTotalConsumers,
			cityTotalConsumers,
			pctAffected,
		},
	});

	const saneparStatus =
		data.saneparInterruptions.length > 0 ? "critical" : "ok";
	services.push({
		name: "Sanepar",
		category: "utility",
		status: saneparStatus,
		details:
			saneparStatus === "ok"
				? "Sem interrupções"
				: `${data.saneparInterruptions.length} interrupção(ões)`,
		timestamp: data.timestamp,
		data: {
			activeEvents: data.saneparInterruptions,
			newEvents: data.newSaneparInterruptions,
		},
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
