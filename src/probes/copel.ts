import { logger } from "../logger.js";
import { type EventTracker, makeHash } from "../state.js";
import type { CopelOutage } from "../types.js";

function normalizeString(str: string): string {
	return str
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.toUpperCase()
		.trim();
}

export interface CopelCheckResult {
	allOutages: CopelOutage[];
	newOutages: CopelOutage[];
	/**
	 * false = a consulta NÃO foi confirmada (HTTP != 200, corpo sem `ocorrencias`,
	 * JSON inválido, rede/timeout). Lista vazia com `consultaOk:false` significa
	 * "não sei", NUNCA "sem ocorrências" — o site já afirmava "Sem ocorrências"
	 * com a API da Copel fora do ar (falha silenciosa, relato do dono 28/09/2026).
	 */
	consultaOk: boolean;
}

export async function checkCopel(
	apiUrl: string,
	municipio: string,
	timeoutMs: number,
	tracker: EventTracker,
): Promise<CopelCheckResult> {
	const allOutages: CopelOutage[] = [];
	const newOutages: CopelOutage[] = [];

	try {
		const resp = await fetch(apiUrl, {
			signal: AbortSignal.timeout(timeoutMs),
			headers: { "User-Agent": "Mozilla/5.0" },
		});
		if (!resp.ok) {
			logger.warn("COPEL API returned non-ok status", { status: resp.status });
			return { allOutages: [], newOutages: [], consultaOk: false };
		}

		const data = (await resp.json()) as {
			ocorrencias?: Record<string, unknown>[];
		};
		// Corpo 200 SEM a chave `ocorrencias` não é "sem ocorrências": é resposta
		// quebrada (a API sempre manda a lista, mesmo vazia).
		if (!Array.isArray(data.ocorrencias)) {
			logger.warn("COPEL API: resposta sem lista de ocorrências");
			return { allOutages: [], newOutages: [], consultaOk: false };
		}
		const ocorrencias = data.ocorrencias;

		const targetMunicipio = normalizeString(municipio);

		for (const oc of ocorrencias) {
			const mun = normalizeString((oc.municipio as string) ?? "");
			if (mun !== targetMunicipio) continue;

			const outage: CopelOutage = {
				idOcorrencia: (oc.id_ocorrencia as string) ?? "",
				numeroSequencial: (oc.numero_sequencial as string) ?? "",
				municipio: (oc.municipio as string) ?? "",
				bairro: (oc.bairro as string) ?? "",
				ehProgramada: (oc.eh_programada as boolean) ?? false,
				tipoPrincipal: (oc.tipo_principal as string) ?? "",
				tipoEvento: (oc.tipo_evento as string) ?? "",
				dataInicio: (oc.data_inicio as string) ?? "",
				previsaoRestabelecimento:
					(oc.previsao_restabelecimento as string | null) ?? null,
				faixaDuracao: (oc.faixa_duracao as string) ?? "",
				statusEquipe: (oc.status_equipe as string) ?? "",
				qtdConsumidores: (oc.qtd_consumidores as number) ?? 0,
				equipeId: (oc.equipe_id as string) ?? "",
			};

			allOutages.push(outage);

		}

		// A Copel pode devolver várias linhas para a mesma ocorrência. Procura
		// primeiro qualquer chave antiga do grupo antes de migrar sua identidade.
		const grupos = new Map<string, CopelOutage[]>();
		for (const outage of allOutages) {
			if (!(outage.tipoPrincipal || "").toUpperCase().includes("INTERRUPCAO")) continue;
			const identidade = outage.idOcorrencia || outage.numeroSequencial;
			const hash = identidade
				? makeHash(identidade)
				: makeHash(outage.municipio, outage.bairro, outage.dataInicio);
			const grupo = grupos.get(hash) ?? [];
			grupo.push(outage);
			grupos.set(hash, grupo);
		}
		for (const [hash, grupo] of grupos) {
			const conhecida = tracker.isKnown("copel_id", hash) || grupo.some((outage) =>
				tracker.isKnown("copel", makeHash(outage.idOcorrencia, outage.numeroSequencial, outage.dataInicio, outage.bairro, String(outage.qtdConsumidores))),
			);
			if (!tracker.isKnown("copel_id", hash)) await tracker.markKnown("copel_id", hash);
			if (!conhecida && grupo[0]) {
				newOutages.push({
					...grupo[0],
					bairro: [...new Set(grupo.map((o) => o.bairro).filter(Boolean))].join(", "),
					qtdConsumidores: grupo.reduce((soma, o) => soma + (Number(o.qtdConsumidores) || 0), 0),
				});
			}
		}

		if (allOutages.length > 0) {
			logger.info("COPEL: ocorrências ativas encontradas", {
				total: allOutages.length,
				novas: newOutages.length,
				municipio,
			});
		}
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		logger.error("Erro ao verificar COPEL", { error: msg });
		return { allOutages: [], newOutages: [], consultaOk: false };
	}

	return { allOutages, newOutages, consultaOk: true };
}
