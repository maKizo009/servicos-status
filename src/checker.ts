import type { AppConfig } from "./config.js";
import { connectivityTargets } from "./config.js";
import { getActiveIspHealthStates, getActiveSignalReports } from "./db.js";
import { logger } from "./logger.js";
import { checkBgpPrefixes } from "./probes/bgp.js";
import { checkConnectivity } from "./probes/connectivity.js";
import { checkCopel } from "./probes/copel.js";
import { checkSanepar } from "./probes/sanepar.js";
import type { EventTracker } from "./state.js";
import type {
	BgpResult,
	ConnectivityResult,
	CopelOutage,
	OperatorName,
	ProbeStatus,
	SaneparInterruption,
	ServiceHealth,
	UnifiedReport,
} from "./types.js";

export interface AllCheckData {
	operators: {
		name: OperatorName;
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
	// Operadoras de telefonia/ISP: REMOVIDAS em 22/09/2026 (pedido do Dave — os
	// testes não tinham utilidade e o monitor não consegue medir a rede da
	// operadora: ping em minhaclaro/meuvivo/meutim mede o site de autoatendimento,
	// não a rede; o BGP só diz o que a operadora anuncia). Cada ciclo gastava 3
	// alvos de conectividade + 3 consultas BGP por operadora. A lista fica vazia
	// para os consumidores (API, alertas, banco) não mudarem de forma de uma vez.
	const operatorResults: AllCheckData["operators"] = [];

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

/**
 * Deriva a classificação fina de uma sondagem. Usa `probeStatus` quando
 * presente (probes atuais) ou infere de success/error (dados antigos do DB).
 */
export function deriveProbeStatus(r: {
	success: boolean;
	error?: string;
	probeStatus?: ProbeStatus;
}): ProbeStatus {
	if (r.probeStatus) return r.probeStatus;
	if (r.success) return "ok";
	if ((r.error ?? "").toLowerCase().includes("timeout")) return "timeout";
	return "failure";
}

/**
 * Número de ciclos consecutivos de falha exigidos para promover uma sondagem
 * a "critical" (debounce — Achado 4). Com checkIntervalMs=60s, 2 = ~2 min.
 */
export const DEBOUNCE_THRESHOLD = 2;

/**
 * Classifica o nível de saúde de uma operadora.
 *
 * Semântica corrigida (Achados 3 e 4) e simplificada (2026-08-12: removido o
 * probe de portal das operadoras — ping em minhaclaro/meuvivo/meutim não mede
 * a rede da operadora, só o site de autoatendimento; fora do escopo do
 * monitor, que não tem como testar a conexão das operadoras diretamente):
 * - Falha CONFIRMADA de conectividade (DNS/HTTP>=500/SSL) → critical após
 *   `debounceThreshold` ciclos (1ª falha = warn).
 * - Timeout de conectividade é INDETERMINADO (problema do monitor ou da rede
 *   dele) → warn.
 * - Latência alta de conectividade (>latencyCritMs) → critical (rede lenta de
 *   verdade no monitor — sinal de problema de rede regional).
 * - BGP: 0 prefixos anunciados (sem erro) → critical (rede da operadora não
 *   está anunciando rotas — dado real vindo do RIPE).
 */
export function assessLevel(
	connectivity: ConnectivityResult[],
	bgp: BgpResult | BgpResult[] | null,
	latencyWarnMs = 150,
	latencyCritMs = 300,
	failureCounts: Map<string, number> = new Map(),
	debounceThreshold = DEBOUNCE_THRESHOLD,
): "ok" | "warn" | "critical" {
	const isFailure = (r: {
		host: string;
		success: boolean;
		error: string;
		probeStatus?: ProbeStatus;
	}) => deriveProbeStatus(r) === "failure";
	const isTimeout = (r: {
		success: boolean;
		error: string;
		probeStatus?: ProbeStatus;
	}) => deriveProbeStatus(r) === "timeout";
	// Debounce: falha só é "confirmada" após N ciclos consecutivos.
	const confirmed = (host: string, failed: boolean): boolean =>
		!failed || (failureCounts.get(host) ?? 0) >= debounceThreshold;

	const bgpList = Array.isArray(bgp) ? bgp : bgp ? [bgp] : [];
	const bgpZeroPrefixes = bgpList.some(
		(b) =>
			Boolean(b) &&
			!b.error &&
			b.prefixCountV4 === 0 &&
			b.prefixCountV6 === 0 &&
			b.asn > 0,
	);

	const connFailures = connectivity.filter(isFailure);
	const confirmedConnFailures = connFailures.filter((c) =>
		confirmed(c.host, true),
	);
	const connTimeouts = connectivity.filter(isTimeout);

	// Latência
	const criticalLatencyConnectivity = connectivity.some(
		(c) => c.latencyMs > latencyCritMs && c.success,
	);

	if (
		confirmedConnFailures.length > 0 ||
		bgpZeroPrefixes ||
		criticalLatencyConnectivity
	)
		return "critical";

	const highLatency = connectivity.some(
		(c) => c.latencyMs > latencyWarnMs && c.success,
	);

	if (connFailures.length > 0 || connTimeouts.length > 0 || highLatency)
		return "warn";

	return "ok";
}

/**
 * Dedupe de ocorrências COPEL por idOcorrencia (Achado 6): mesma ocorrência
 * listada 2x (ex: múltiplos grupos de consumidores) não conta dobrado.
 * Mantém a versão com maior qtdConsumidores. Exportada para teste.
 */
export function dedupeCopelOutages(outages: CopelOutage[]): {
	unique: CopelOutage[];
	duplicates: number;
} {
	const dedupKey = (o: CopelOutage): string =>
		o.idOcorrencia || `${o.bairro}|${o.dataInicio}`;
	const seen = new Map<string, CopelOutage>();
	let duplicates = 0;
	for (const o of outages) {
		const k = dedupKey(o);
		const prev = seen.get(k);
		if (prev) {
			duplicates++;
			// Mantém a versão com maior qtdConsumidores como proxy de
			// atualização; pode ser ajustado se a API expor timestamps.
			if ((o.qtdConsumidores || 0) > (prev.qtdConsumidores || 0)) {
				seen.set(k, o);
			}
		} else {
			seen.set(k, o);
		}
	}
	return { unique: [...seen.values()], duplicates };
}

export async function buildUnifiedReport(
	data: AllCheckData,
	latencyWarnMs = 150,
	latencyCritMs = 300,
	failureCounts: Map<string, number> = new Map(),
	debounceThreshold = DEBOUNCE_THRESHOLD,
	// Total de UCs do município (API validador_populacao da Copel; Ipiranga =
	// 6017 em 2026-09-12). Passado pelo chamador a partir de
	// config.copelTotalConsumersCity (override via COPEL_TOTAL_CONSUMERS_CITY).
	cityTotalConsumersParam?: number,
): Promise<UnifiedReport> {
	const services: ServiceHealth[] = [];
	const signalReports = await getActiveSignalReports();
	const ispHealthStates = await getActiveIspHealthStates();

	for (const op of data.operators) {
		let status = assessLevel(
			op.connectivityResults,
			op.bgpResult,
			latencyWarnMs,
			latencyCritMs,
			failureCounts,
			debounceThreshold,
		);
		const connFailures = op.connectivityResults.filter(
			(c) => deriveProbeStatus(c) === "failure",
		).length;
		const bgpFail =
			op.bgpResult &&
			!op.bgpResult.error &&
			op.bgpResult.prefixCountV4 === 0 &&
			op.bgpResult.prefixCountV6 === 0;

		const activeSignalReport = signalReports.find(
			(r) => r.operator === op.name && r.status !== "ok",
		);

		const crowdsourcedIspState = ispHealthStates.find(
			(i) => i.operator === op.name,
		);

		if (activeSignalReport) {
			if (activeSignalReport.status === "down") {
				status = "critical";
			} else if (status === "ok") {
				status = "warn";
			}
		} else if (crowdsourcedIspState && crowdsourcedIspState.status !== "ok") {
			const csWeight = { ok: 0, warn: 1, critical: 2 };
			const currentWeight = { ok: 0, warn: 1, critical: 2 }[status];
			if (csWeight[crowdsourcedIspState.status] > currentWeight) {
				status = crowdsourcedIspState.status;
			}
		}

		let details = "OK";
		if (activeSignalReport) {
			details = `⚠️ Sinal Local: ${activeSignalReport.signalType} (${activeSignalReport.notes || "Relato de instabilidade local"})`;
		} else if (crowdsourcedIspState && crowdsourcedIspState.status !== "ok") {
			details = crowdsourcedIspState.details;
		} else if (status === "critical") {
			const parts: string[] = [];
			if (connFailures > 0)
				parts.push(`${connFailures} teste(s) de conectividade falharam`);
			if (bgpFail) parts.push("0 prefixos BGP anunciados");
			if (
				op.connectivityResults.some(
					(c) => c.latencyMs > latencyCritMs && c.success,
				)
			)
				parts.push("Latência crítica de rede (>300ms)");
			details = parts.join(", ") || "Falha de serviço";
		} else if (status === "warn") {
			const parts: string[] = [];
			if (connFailures > 0)
				parts.push(`${connFailures} teste(s) de conectividade falharam`);
			if (
				op.connectivityResults.some(
					(c) => c.latencyMs > latencyWarnMs && c.success,
				)
			)
				parts.push("Latência elevada de rede (>150ms)");
			details = parts.join(", ") || "Latência elevada detectada";
		}

		services.push({
			name: op.name,
			category: "telecom",
			status,
			details,
			timestamp: data.timestamp,
			data: {
				connectivityResults: op.connectivityResults,
				bgp: op.bgpResult,
				signalReport: activeSignalReport ?? null,
				crowdsourcedState: crowdsourcedIspState ?? null,
			},
		});
	}

	// PARIDADE COM O MAPA OFICIAL ANEEL (cdn.copel.com/aneel-informacoes):
	// o front da Copel filtra tipo_principal=INTERRUPCAO antes de agregar
	// (`if (!tipoPrinc.includes('INTERRUPCAO')) return;`) — EMERGENCIA é
	// solicitação ainda não confirmada e NÃO entra nas UCs/OCs. Ocorrências =
	// ids distintos; Desligados = SOMA de qtd_consumidores de todas as linhas
	// (sem dedupe — ex: 12/09/2026: 5 ocorrências, 471 UCs, 160 em 6-12h e
	// 311 em 12-24h). Programada x não-programada via eh_programada.
	const isInterrupcao = (o: CopelOutage): boolean =>
		(o.tipoPrincipal || "").toUpperCase().includes("INTERRUPCAO");
	const interrupcoes = data.copelOutages.filter(isInterrupcao);
	const emergenciasNaoConfirmadas = data.copelOutages.filter(
		(o) => !isInterrupcao(o),
	);
	const interrupcaoIds = new Set(
		interrupcoes.map((o) => o.idOcorrencia || `${o.bairro}|${o.dataInicio}`),
	);
	const copelStatusConfirmed =
		interrupcoes.length > 0 ? "critical" : "ok";

	// Idade da interrupção mais antiga. Sem isso o card mostra só a contagem de
	// UCs — que fica IGUAL por horas numa queda longa e parece scraper travado
	// (foi a suspeita do Dave em 22/09/2026: 180 UCs desde 21/09 17:37, uma
	// interrupção real da Copel, não falha nossa). A API da Copel devolve hora
	// LOCAL de Brasília e o runtime da Vercel roda em UTC: sem o offset
	// explícito a idade sairia 3 h errada.
	const idadeInterrupcaoMaisAntiga = (lista: CopelOutage[]): string => {
		const tempos = lista
			.map((o) => {
				const m = String(o.dataInicio ?? "").match(
					/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/,
				);
				if (!m) return null;
				return Date.parse(
					`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}-03:00`,
				);
			})
			.filter((t): t is number => t !== null && Number.isFinite(t));
		if (tempos.length === 0) return "";
		const horas = (Date.now() - Math.min(...tempos)) / 3_600_000;
		if (horas < 1) return "a mais antiga há menos de 1 hora";
		const h = Math.floor(horas);
		return `a mais antiga há ${h} ${h === 1 ? "hora" : "horas"}`;
	};
	const copelIdadeAntiga = idadeInterrupcaoMaisAntiga(interrupcoes);

	// Dedupe informativo (Achado 6): mesma ocorrência listada 2x (ex:
	// múltiplos grupos de consumidores). Mantido como estatística — a SOMA
	// oficial não usa dedupe.
	const { unique: uniqueOutages, duplicates: copelDupes } =
		dedupeCopelOutages(interrupcoes);
	if (copelDupes > 0) {
		logger.warn("COPEL: idOcorrencia duplicado detectado na mesma leitura", {
			dupes: copelDupes,
			ocorrenciasBrutas: interrupcoes.length,
			ocorrenciasUnicas: uniqueOutages.length,
		});
	}

	const copelTotalConsumers = interrupcoes.reduce(
		(sum, o) => sum + (o.qtdConsumidores || 0),
		0,
	);
	const copelProgConsumers = interrupcoes
		.filter((o) => o.ehProgramada)
		.reduce((sum, o) => sum + (o.qtdConsumidores || 0), 0);
	const copelNonProgConsumers = copelTotalConsumers - copelProgConsumers;
	const faixasDuracao: Record<string, number> = {};
	for (const o of interrupcoes) {
		const f = o.faixaDuracao || "desconhecida";
		faixasDuracao[f] = (faixasDuracao[f] ?? 0) + (o.qtdConsumidores || 0);
	}
	// Total oficial de UCs do município (validador_populacao; default 6017).
	const cityTotalConsumers = cityTotalConsumersParam ?? 6017;
	const pctAffected = Number(
		((copelTotalConsumers / cityTotalConsumers) * 100).toFixed(2),
	);

	// Desligamentos PROGRAMADOS (lembrete no topo da página): ocorrências
	// com eh_programada=true. A API da Copel (mapa_poligonos_data) expõe a
	// lista na MESMA resposta das emergências — campo eh_programada — e o
	// probe já filtra por município; aqui só separamos para a UI.
	const scheduledOutages = interrupcoes.filter((o) => o.ehProgramada);

	services.push({
		name: "Copel",
		category: "utility",
		status: copelStatusConfirmed,
		details:
			copelStatusConfirmed === "ok"
				? emergenciasNaoConfirmadas.length > 0
					? `${emergenciasNaoConfirmadas.length} solicitação(ões) não confirmada(s) — sem interrupção ativa`
					: "Sem ocorrências"
				: copelTotalConsumers > 0
					? `${copelTotalConsumers} UCs sem energia em ${interrupcaoIds.size} ocorrência(s)` +
						(copelIdadeAntiga ? ` — ${copelIdadeAntiga}` : "") +
						(emergenciasNaoConfirmadas.length > 0
							? ` (+${emergenciasNaoConfirmadas.length} não confirmada(s))`
							: "")
					: `${interrupcaoIds.size} ocorrência(s)`,
		timestamp: data.timestamp,
		data: {
			activeEvents: interrupcoes,
			newEvents: data.newCopelOutages,
			totalConsumers: copelTotalConsumers,
			nonProgConsumers: copelNonProgConsumers,
			progConsumers: copelProgConsumers,
			ocorrencias: interrupcaoIds.size,
			faixasDuracao,
			cityTotalConsumers,
			pctAffected,
			duplicatesFound: copelDupes,
			scheduledOutages,
			emergencyRequests: emergenciasNaoConfirmadas,
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
