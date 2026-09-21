/**
 * Gate determinístico de coerência do boletim (Camada B) contra o radar.
 *
 * Módulo PURO (zero dependência pesada) para poder ser importado no request
 * path sem puxar a cadeia LLM (que index.ts carrega por import dinâmico).
 *
 * Caso real 21/09/2026 22:55: com um núcleo muito forte (58 dBZ) a 147 km em
 * ZONA DE VIGILÂNCIA, o boletim do LLM abriu com "nenhum núcleo por perto" e
 * descreveu o MESMO núcleo na frase seguinte. Instrução no prompt NÃO resolve
 * (o modelo ignorou) e o texto ficou 30 min no cache. Regra do sistema: o dado
 * determinístico é a fonte da verdade — texto que o contradiz é descartado e a
 * heurística assume.
 */

/** Frases que afirmam NÃO haver chuva/núcleo por perto (contradição com radar). */
const FRASE_NADA_POR_PERTO =
	/nenhum[ao]s?\s+(núcleo|nucleo|chuva)|sem\s+(núcleo|nucleo|chuva)s?\s+(por perto|relevante|na regi)|radar limpo/i;

/**
 * `false` = texto incoerente com o radar (deve ser descartado). Rejeita quando:
 *  - existe entidade em watch/alert a ≤200 km E o texto diz que não há nada
 *    por perto; ou
 *  - existe entidade relevante E o texto omite distância (leitor precisa saber
 *    ONDE está); ou
 *  - existe entidade em zona de ALERTA E o texto não demonstra urgência.
 * Sem entidade relevante, qualquer texto passa (o radar não contradiz nada).
 */
export function passaCoerenciaAmeaca(
	text: string,
	threats: { distToTargetKm: number; relevanceZone?: string }[],
): boolean {
	if (!text || text.trim().length === 0) return false;
	const relevantes = threats.filter(
		(t) =>
			t.relevanceZone != null &&
			t.relevanceZone !== "monitor" &&
			t.distToTargetKm <= 200,
	);
	if (relevantes.length === 0) return true;
	if (FRASE_NADA_POR_PERTO.test(text)) return false;
	if (!/\d{2,4}\s*km/.test(text)) return false;
	const temAlerta = relevantes.some((t) => t.relevanceZone === "alert");
	if (temAlerta && !/alerta|iminente|iminência|próximas|risco/i.test(text))
		return false;
	return true;
}
