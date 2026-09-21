/**
 * Fonte pública CEMADEN (sem login/captcha) — pluviômetros automáticos.
 *
 * O `getJson2.php?uf=X` (resources.cemaden.gov.br) lista TODAS as estações
 * pluviométricas do CEMADEN por UF com acumulados ao vivo (acc1hr..acc96hr) e
 * o horário da última leitura. A API PED (login) e o webservice de histórico
 * (mapservices) não estão utilizáveis — o getJson2 é a fonte pública estável.
 *
 * Escopo: apenas as estações de IPIRANGA/PR (código IBGE 4110508) — as duas
 * G2-411050801A (19035) e G2-411050802A (19036).
 */

const GETJSON2_BASE = "https://resources.cemaden.gov.br/graficos/interativo/getJson2.php";
const CODIBGE_IPIRANGA = 4110508;
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Rótulos amigáveis por idestacao (localidade real em Ipiranga/PR):
 * - 19035 (G2-411050801A): centro da cidade (-25.025096, -50.581797)
 * - 19036 (G2-411050802A): localidade de São Brás (-24.924012, -50.59779)
 * Nome do CEMADEN fica como fallback para estações futuras desconhecidas.
 */
const ROTULOS_LOCALIDADE: Record<number, string> = {
	19035: "Ipiranga (Centro)",
	19036: "Ipiranga (São Brás)",
};

/**
 * Frescor máximo aceitável para DECISÃO. A cadência do CEMADEN é de 10 min;
 * 90 min dá margem para falha de transmissão sem confundir com "sem chuva".
 * Motivo de existir: o campo `"-"`/nulo é AMBÍGUO (pode ser "não choveu" ou
 * "estação parada") — e estação parada lida como 0 vira "sem chuva" silencioso,
 * que é pior que não ter dado nenhum. Casos reais no PR: estações paradas há
 * meses (Dois Vizinhos 23/06/26, Campo do Tenente 13/03/26).
 */
export const CEMADEN_FRESCOR_MAX_MIN = 90;

/** "DD/MM/YY HH:mm" (UTC, como o CEMADEN entrega) → epoch ms. null se não parsear. */
export function utcParaEpoch(dataHoraUtc: string | null): number | null {
	if (!dataHoraUtc) return null;
	const m = dataHoraUtc.match(/^(\d{2})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2})$/);
	if (!m) return null;
	const [, dd, mm, yy, hh, min] = m;
	return Date.UTC(2000 + Number(yy), Number(mm) - 1, Number(dd), Number(hh), Number(min));
}

/**
 * O CEMADEN entrega dataHoraUltimovalor em UTC ("DD/MM/YY HH:mm").
 * Converte para horário de Brasília (UTC-3 fixo — sem DST no BR desde 2019).
 * Devolve no MESMO formato "DD/MM/YY HH:mm" para não quebrar os consumidores.
 */
export function utcParaHorarioBrasilia(dataHoraUtc: string | null): string | null {
	if (!dataHoraUtc) return null;
	const m = dataHoraUtc.match(/^(\d{2})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2})$/);
	if (!m) return dataHoraUtc;
	const [, dd, mm, yy, hh, min] = m;
	const utc = Date.UTC(
		2000 + Number(yy),
		Number(mm) - 1,
		Number(dd),
		Number(hh),
		Number(min),
	);
	const br = new Date(utc - 3 * 3_600_000);
	const p = (n: number) => String(n).padStart(2, "0");
	return `${p(br.getUTCDate())}/${p(br.getUTCMonth() + 1)}/${p(
		br.getUTCFullYear() % 100,
	)} ${p(br.getUTCHours())}:${p(br.getUTCMinutes())}`;
}

export interface CemadenLeitura {
	/** id da estação no sistema CEMADEN (ex: 19035). */
	idestacao: number;
	/** Nome no CEMADEN (ex: "G2-411050801A"). */
	nome: string;
	cidade: string;
	uf: string;
	codibge: number;
	/** Última leitura instantânea (mm). */
	ultimoValor: number | null;
	/** "13/08/26 20:10" (UTC) — horário da última leitura. */
	dataHoraUltimoValor: string | null;
	/** Acumulados em janelas móveis (mm). null quando a estação não reporta. */
	acc1hr: number | null;
	acc3hr: number | null;
	acc6hr: number | null;
	acc12hr: number | null;
	acc24hr: number | null;
	acc48hr: number | null;
	acc72hr: number | null;
	acc96hr: number | null;
	/** Minutos desde a última leitura (null = horário ilegível). */
	frescorMin: number | null;
	/** true = leitura velha demais para decidir: os acumulados NÃO valem como "sem chuva". */
	stale: boolean;
}

export interface CemadenState {
	estacoes: CemadenLeitura[];
	fonte: string;
	/** Epoch (ms) da última leitura do getJson2. */
	atualizadoEm: number | null;
	erro?: string | null;
}

function parseAcc(v: unknown): number | null {
	if (v === "-" || v === null || v === undefined) return null;
	const n = Number(v);
	return Number.isFinite(n) ? n : null;
}

/** Busca as leituras CEMADEN de Ipiranga/PR (1 chamada ao getJson2 do PR). */
export async function fetchCemadenIpiranga(): Promise<CemadenState> {
	try {
		const res = await fetch(`${GETJSON2_BASE}?uf=PR`, {
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			headers: { Accept: "application/json" },
		});
		if (!res.ok) {
			return { estacoes: [], fonte: "Cemaden", atualizadoEm: null, erro: `HTTP ${res.status}` };
		}
		const lista = (await res.json()) as any[];
		const estacoes: CemadenLeitura[] = lista
			.filter((x) => Number(x.codibge) === CODIBGE_IPIRANGA)
			.map((x) => {
				const id = Number(x.idestacao);
				// Frescor: o CEMADEN entrega em UTC. Estação velha NÃO pode virar "sem chuva".
				const dh = x.datahoraUltimovalor ? String(x.datahoraUltimovalor) : null;
				const ep = utcParaEpoch(dh);
				const frescorMin = ep === null ? null : Math.round((Date.now() - ep) / 60_000);
				return {
					idestacao: id,
					// Rótulo por localidade (Centro / São Brás) — nome técnico
					// do CEMADEN vira fallback para estações novas.
					nome: ROTULOS_LOCALIDADE[id] ?? String(x.nomeestacao || ""),
					cidade: String(x.cidade || ""),
					uf: String(x.uf || ""),
					codibge: Number(x.codibge),
					ultimoValor: parseAcc(x.ultimovalor),
					// CEMADEN entrega em UTC — converte para horário de Brasília.
					dataHoraUltimoValor: utcParaHorarioBrasilia(
						x.datahoraUltimovalor ? String(x.datahoraUltimovalor) : null,
					),
					acc1hr: parseAcc(x.acc1hr),
					acc3hr: parseAcc(x.acc3hr),
					acc6hr: parseAcc(x.acc6hr),
					acc12hr: parseAcc(x.acc12hr),
					acc24hr: parseAcc(x.acc24hr),
					acc48hr: parseAcc(x.acc48hr),
					acc72hr: parseAcc(x.acc72hr),
					acc96hr: parseAcc(x.acc96hr),
					frescorMin,
					stale: frescorMin === null || frescorMin > CEMADEN_FRESCOR_MAX_MIN,
				};
			})
			.sort((a, b) => a.idestacao - b.idestacao);

		return { estacoes, fonte: "Cemaden", atualizadoEm: Date.now(), erro: null };
	} catch (e: any) {
		return { estacoes: [], fonte: "Cemaden", atualizadoEm: null, erro: e?.message || "falha" };
	}
}

/**
 * Máximo de um acumulado considerando SÓ estações FRESCAS.
 *
 * Sem estação fresca → null (= "sem dado"), nunca 0 (= "sem chuva"). Essa é a
 * diferença que o alerta precisa saber: "não choveu" e "não sei" levam a
 * decisões diferentes, e antes do fix os dois viravam 0.
 */
export function maxAcumuladoFresco(
	estacoes: CemadenLeitura[],
	f: (e: CemadenLeitura) => number | null,
): number | null {
	const frescas = estacoes.filter((e) => !e.stale);
	if (!frescas.length) return null;
	return Math.max(...frescas.map((e) => f(e) ?? 0));
}

/** Há alguma estação fresca? false = o pluviômetro local não está reportando. */
export function temEstacaoFresca(estacoes: CemadenLeitura[]): boolean {
	return estacoes.some((e) => !e.stale);
}
