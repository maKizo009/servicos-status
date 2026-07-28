import { logger } from "../logger";
import { type EventTracker, makeHash } from "../state";
import type { CopelOutage } from "../types";

function normalizeString(str: string): string {
	return str
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.toUpperCase()
		.trim();
}

export async function checkCopel(
	apiUrl: string,
	municipio: string,
	timeoutMs: number,
	tracker: EventTracker,
): Promise<CopelOutage[]> {
	const newOutages: CopelOutage[] = [];

	try {
		const resp = await fetch(apiUrl, {
			signal: AbortSignal.timeout(timeoutMs),
			headers: { "User-Agent": "Mozilla/5.0" },
		});
		if (!resp.ok) {
			logger.warn("COPEL API returned non-ok status", { status: resp.status });
			return [];
		}

		const data = (await resp.json()) as {
			ocorrencias?: Record<string, unknown>[];
		};
		const ocorrencias = data.ocorrencias ?? [];

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

			const h = makeHash(
				outage.idOcorrencia,
				outage.numeroSequencial,
				outage.dataInicio,
				outage.bairro,
			);
			if (!tracker.isKnown("copel", h)) {
				tracker.markKnown("copel", h);
				newOutages.push(outage);
			}
		}

		if (newOutages.length > 0) {
			logger.info("COPEL: novas ocorrências encontradas", {
				count: newOutages.length,
				municipio,
			});
		}
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		logger.error("Erro ao verificar COPEL", { error: msg });
	}

	return newOutages;
}
