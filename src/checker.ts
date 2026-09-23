import type { AppConfig } from "./config.js";
import { logger } from "./logger.js";
import { checkCopel } from "./probes/copel.js";
import { checkSanepar } from "./probes/sanepar.js";
import type { EventTracker } from "./state.js";
import type {
	CopelOutage,
	SaneparInterruption,
	ServiceHealth,
	UnifiedReport,
} from "./types.js";

export interface AllCheckData {
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
	// testes não tinham utilidade: o monitor não mede a rede da operadora, só o
	// site de autoatendimento, e o BGP só diz o que ela anuncia). Cada ciclo
	// gastava 3 alvos de conectividade + 3 consultas BGP por operadora.

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
		copelOutages: copelRes.allOutages,
		newCopelOutages: copelRes.newOutages,
		saneparInterruptions: saneparRes.allInterruptions,
		newSaneparInterruptions: saneparRes.newInterruptions,
		timestamp,
	};
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
	// Total de UCs do município (API validador_populacao da Copel; Ipiranga =
	// 6017 em 2026-09-12). Passado pelo chamador a partir de
	// config.copelTotalConsumersCity (override via COPEL_TOTAL_CONSUMERS_CITY).
	cityTotalConsumersParam?: number,
): Promise<UnifiedReport> {
	const services: ServiceHealth[] = [];

	// Aqui era montado o ServiceHealth de cada OPERADORA (Claro/Vivo/TIM): nível
	// por assessLevel, falhas de conectividade, prefixos BGP e o relato de sinal do
	// morador. Removido em 22/09/2026 com as operadoras — o relatório unificado
	// agora só carrega COPEL e Sanepar abaixo.

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
		if (horas < 1) return "a mais antiga há <1h";
		const h = Math.floor(horas);
		return `a mais antiga há ${h}h`;
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
					? `${emergenciasNaoConfirmadas.length} ${emergenciasNaoConfirmadas.length === 1 ? "solicitação" : "solicitações"} não confirmadas — sem interrupção ativa`
					: "Sem ocorrências"
				: copelTotalConsumers > 0
					? `${copelTotalConsumers} UCs sem energia em ${interrupcaoIds.size} ${interrupcaoIds.size === 1 ? "ocorrência" : "ocorrências"}` +
						(copelIdadeAntiga ? ` — ${copelIdadeAntiga}` : "") +
						(emergenciasNaoConfirmadas.length > 0
							? ` (+${emergenciasNaoConfirmadas.length} não ${emergenciasNaoConfirmadas.length === 1 ? "confirmada" : "confirmadas"})`
							: "")
					: `${interrupcaoIds.size} ${interrupcaoIds.size === 1 ? "ocorrência" : "ocorrências"}`,
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
