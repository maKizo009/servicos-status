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
 *
 * ⚠️ PITFALLS (21/09/2026) — três defeitos seguidos no MESMO gate, todos
 * invisíveis ao teste que usava fragmento de texto:
 *  1. Barra dupla (`\\s`) escrita pelo gerador do arquivo: regex válido, casando
 *     barra literal — nunca casava nada.
 *  2. `nenhum[ao]s?` EXIGE a vogal: casava "nenhuma"/"nenhumas" e NUNCA o
 *     "nenhum" puro, que era justamente o texto real de produção.
 *  3. Interpolação de alternativa com plural duplo ("nenhuns núcleos") não
 *     fechava como esperado.
 * Regra que ficou: (a) gate não depende de escape de barra — usa classes
 * explícitas; (b) teste do gate usa o TEXTO REAL completo (frase proibida +
 * distância + flexões de número/gênero), nunca fragmento "de exemplo".
 */

/** Separador entre palavras: espaço, espaço duro, pontuação, quebra de linha. */
const SEP = "[^A-Za-z0-9À-ÿ]+";

/**
 * Frases que afirmam NÃO haver chuva/núcleo por perto (contradição com radar).
 * Flexões explícitas (nenhum/nenhuma/nenhuns/nenhumas) para não depender de
 * quantificador opcional — foi exatamente aí que a 1ª versão falhou.
 */
const FRASE_NADA_POR_PERTO = new RegExp(
	[
		"(?:nenhum|nenhuma|nenhuns|nenhumas)" +
			SEP +
			"(?:núcleo|nucleo|núcleos|nucleos|chuva|chuvas)",
		"sem" +
			SEP +
			"(?:núcleo|nucleo|núcleos|nucleos|chuva|chuvas)" +
			SEP +
			"(?:por perto|relevante|na regi)",
		"radar limpo",
	].join("|"),
	"i",
);

/** Distância citada no texto (km) — o leitor precisa saber ONDE está a chuva. */
const CITA_DISTANCIA = /[0-9]{2,4}[^A-Za-z0-9À-ÿ]*km/;

/** Sinal de urgência exigido quando existe entidade em zona de ALERTA. */
const TOM_DE_URGENCIA = /alerta|iminente|iminência|próximas|risco/i;

/**
 * `false` = texto incoerente com o radar (deve ser descartado). Rejeita quando:
 *  - existe entidade em watch/alert a ≤200 km E o texto diz que não há nada
 *    por perto; ou
 *  - existe entidade relevante E o texto omite distância
 *    (o leitor precisa saber ONDE está); ou
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
	if (!CITA_DISTANCIA.test(text)) return false;
	if (
		relevantes.some((t) => t.relevanceZone === "alert") &&
		!TOM_DE_URGENCIA.test(text)
	)
		return false;
	return true;
}
