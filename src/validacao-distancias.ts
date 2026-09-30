/**
 * Validação de distâncias citadas em texto (boletim/narrativa).
 *
 * Causa raiz (30/09/2026): o watchdog reprovou boletim CORRETO porque comparou
 * a distância da CIDADE citada ("Guaporema a 294 km" = centróide da malha
 * IBGE, 297 km reais) com `distToTargetKm` do NÚCLEO (270 km) — duas métricas
 * diferentes com tolerância de 20 km. O núcleo não fica no centro da cidade;
 * 20-30 km de diferença são esperados.
 *
 * Regra única (usada pelo gate do gerador E pelo watchdog):
 * - distância citada junto de um MUNICÍPIO da malha → aceita se bate com o
 *   CENTRÓIDE da cidade (tolerância máx(25 km, 12%)) OU com a distância da
 *   ENTIDADE pareada com essa cidade no nowcast (distToTargetKm, tolerância
 *   máx(20 km, 8%)) — o template do analista escreve "área em X, a N km" com
 *   N da ENTIDADE, então reprovar só pelo centróide derrubava boletim correto
 *   (30/09/2026, ciclos 14:40: "Santa Isabel do Ivaí a 333 km" é a distância
 *   da área, e o extrator antigo ainda casava o nome curto "Santa Isabel" —
 *   outro município, centróide 481 km);
 * - distância citada sem cidade → compara com as distâncias REAIS dos núcleos
 *   (`distToTargetKm`, tolerância máx(20 km, 8%)); sem referência nenhuma
 *   (radar limpo), aceita — não há o que contradizer.
 * - "km" sem número (mm, dBZ, h) nunca entra: só `<número> km`.
 *
 * Puro (sem fetch/sem I/O além da malha estática) — testado em
 * scripts/test-distancias.ts.
 */
import MALHA_SUL from "./data/sul-municipios.js";
import { rotularLocalizacao } from "./geo-municipio.js";

/** Alvo de referência (Ipiranga) — mesmo do llm-formatter/geo-municipio. */
export const ALVO = { lat: -25.0244, lon: -50.5847 };

interface EntradaMalha {
	c: number;
	n: string;
	g: number[][][];
}

function haversineKm(
	lat1: number,
	lon1: number,
	lat2: number,
	lon2: number,
): number {
	const R = 6371.0088;
	const dLat = ((lat2 - lat1) * Math.PI) / 180;
	const dLon = ((lon2 - lon1) * Math.PI) / 180;
	const a =
		Math.sin(dLat / 2) ** 2 +
		Math.cos((lat1 * Math.PI) / 180) *
			Math.cos((lat2 * Math.PI) / 180) *
			Math.sin(dLon / 2) ** 2;
	return 2 * R * Math.asin(Math.sqrt(a));
}

const semAcento = (s: string): string =>
	s
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase();

/** Cache de nome normalizado → distância do centróide até o alvo. */
const cacheDistMunicipio = new Map<string, number | null>();

/** Distância do CENTRÓIDE do município (malha IBGE) até o alvo, em km. */
export function distanciaMunicipioKm(
	nome: string,
	alvo: { lat: number; lon: number } = ALVO,
): number | null {
	const chave = semAcento(nome.trim());
	const cacheada = cacheDistMunicipio.get(chave);
	if (cacheada !== undefined) return cacheada;
	const malha = MALHA_SUL as unknown as EntradaMalha[];
	let resultado: number | null = null;
	for (const e of malha) {
		if (semAcento(e.n) !== chave) continue;
		const anel = e.g[0] ?? [];
		if (anel.length === 0) break;
		const lon = anel.reduce((s, p) => s + p[0], 0) / anel.length;
		const lat = anel.reduce((s, p) => s + p[1], 0) / anel.length;
		resultado = haversineKm(alvo.lat, alvo.lon, lat, lon);
		break;
	}
	cacheDistMunicipio.set(chave, resultado);
	return resultado;
}

export interface DistanciaCitada {
	km: number;
	/** Município da malha citado a até 45 chars antes do número (null = sem). */
	cidade: string | null;
}

/**
 * Extrai as distâncias citadas (`<número> km`) com a cidade associada.
 * "22,6 mm", "38 dBZ", "12 h" NÃO são distâncias e não entram.
 */
export function extrairDistanciasCitadas(text: string): DistanciaCitada[] {
	const achados: DistanciaCitada[] = [];
	const re = /(\d+(?:[.,]\d+)?)\s*km\b/gi;
	const malha = MALHA_SUL as unknown as EntradaMalha[];
	let m: RegExpExecArray | null;
	while ((m = re.exec(text)) !== null) {
		const km = Number(m[1]?.replace(",", "."));
		if (!Number.isFinite(km) || km <= 0) continue;
		const antes = text.slice(Math.max(0, m.index - 45), m.index);
		const antesNorm = semAcento(antes);
		// Vários nomes da malha podem casar na mesma janela (ex.: "Mangueirinha"
		// e "Guaporema" antes de "294 km"; ou "Santa Isabel" DENTRO de "Santa
		// Isabel do Ivaí"). A referência certa é o nome cujo match TERMINA mais
		// perto do número — que, no caso de prefixo, é automaticamente o nome
		// MAIS LONGO ("santa isabel do ivai" termina depois de "santa isabel").
		// O extrator antigo pegava o primeiro da malha e validava contra o
		// centróide do município ERRADO (481 km vs 342 km) e o boletim CORRETO
		// caía na heurística (30/09/2026, ciclos 14:40). Só palavra inteira.
		let cidade: string | null = null;
		let fimDoMatchMaisProximo = -1;
		let nomeEscolhidoNorm = "";
		for (const e of malha) {
			const nomeNorm = semAcento(e.n);
			if (nomeNorm.length < 4) continue; // "Cruz", "Ipa"... dão match frouxo
			const idx = antesNorm.lastIndexOf(nomeNorm);
			if (idx < 0) continue;
			const antesDoIdx = antesNorm.slice(Math.max(0, idx - 1), idx);
			if (idx > 0 && /[a-z0-9]/.test(antesDoIdx)) continue; // casa sufixo, não palavra
			const fim = antesNorm.slice(idx + nomeNorm.length);
			if (/[a-z0-9]/.test(fim.slice(0, 1))) continue; // casa prefixo, não palavra
			const fimDoMatch = idx + nomeNorm.length;
			// Empate de fim (ex.: "ivai" termina junto com "santa isabel do
			// ivai") → vence o nome MAIS LONGO (mais específico).
			const vence =
				fimDoMatch > fimDoMatchMaisProximo ||
				(fimDoMatch === fimDoMatchMaisProximo &&
					nomeNorm.length > nomeEscolhidoNorm.length);
			if (vence) {
				fimDoMatchMaisProximo = fimDoMatch;
				nomeEscolhidoNorm = nomeNorm;
				cidade = e.n;
			}
		}
		achados.push({ km, cidade });
	}
	return achados;
}

export interface ResultadoDistancias {
	ok: boolean;
	problemas: string[];
}

/**
 * Referência de entidade do nowcast: distância real (`distToTargetKm`) e o
 * MUNICÍPIO com que o prompt do analista pareia essa distância. Números puros
 * (legado) entram como entidade SEM rótulo — servem só p/ citação sem cidade.
 */
export interface RefDistancia {
	km: number;
	municipio?: string | null;
}

/**
 * Converte entidades do nowcast (com lat/lon) em referências rotuladas pelo
 * MESMO rótulo do prompt (`rotularLocalizacao`) — é o pareamento que o gate
 * valida: "área em <municipio>, a <distToTargetKm> km".
 */
export function refsDasAmeacas(
	ameacas: Array<{ lat: number; lon: number; distToTargetKm?: number | null }>,
): RefDistancia[] {
	return ameacas
		.filter(
			(a) => typeof a.distToTargetKm === "number" && a.distToTargetKm > 0,
		)
		.map((a) => ({
			km: a.distToTargetKm as number,
			municipio:
				rotularLocalizacao(a.lat, a.lon, haversineKm).municipio?.nome ?? null,
		}));
}

/**
 * Valida cada distância citada contra as referências legítimas do texto.
 *
 * Métricas (lição 30/09/2026: "qual é a métrica desta afirmação?"):
 * - "<cidade> a N km" pode citar a distância da CIDADE (centróide IBGE) OU a
 *   distância da ENTIDADE que o template pareia com essa cidade ("área em X,
 *   a N km" = distToTargetKm da área). Aceita as DUAS; reprova só se N bate
 *   com nenhuma. Entidade sem rótulo (número puro) NÃO valida citação com
 *   cidade — sem rótulo não dá pra confirmar o pareamento.
 * - "N km" sem cidade → compara com as distâncias das entidades; sem
 *   entidade nenhuma (radar limpo), aceita — não há o que contradizer.
 */
export function avaliarDistanciasCitadas(
	text: string,
	distanciasReaisKm: Array<number | RefDistancia>,
	alvo: { lat: number; lon: number } = ALVO,
): ResultadoDistancias {
	const problemas: string[] = [];
	const refs: RefDistancia[] = distanciasReaisKm
		.map((r) => (typeof r === "number" ? { km: r, municipio: null } : r))
		.filter((r) => Number.isFinite(r.km) && r.km > 0);
	const reais = refs.map((r) => r.km);
	for (const citada of extrairDistanciasCitadas(text)) {
		if (citada.cidade) {
			const dCidade = distanciaMunicipioKm(citada.cidade, alvo);
			const tolCidade = Math.max(25, citada.km * 0.12);
			const bateCidade =
				dCidade != null && Math.abs(dCidade - citada.km) <= tolCidade;
			const citadaNorm = semAcento(citada.cidade);
			const tolEntidade = Math.max(20, citada.km * 0.08);
			const bateEntidade = refs.some(
				(r) =>
					r.municipio != null &&
					semAcento(r.municipio) === citadaNorm &&
					Math.abs(r.km - citada.km) <= tolEntidade,
			);
			if (bateCidade || bateEntidade) continue;
			if (dCidade == null && reais.length === 0) continue; // sem nada p/ julgar
			problemas.push(
				`"${citada.cidade} a ${citada.km} km" não bate com a distância da cidade (${dCidade != null ? Math.round(dCidade) : "fora da malha"}) nem com nenhuma entidade pareada (${refs.filter((r) => r.municipio != null).map((r) => `${Math.round(r.km)} km@${r.municipio}`).join("; ") || "sem entidades rotuladas"})`,
			);
			continue;
		}
		if (reais.length === 0) continue; // sem núcleo medido: não há o que contradizer
		const tol = Math.max(20, citada.km * 0.08);
		const bate = reais.some((d) => Math.abs(d - citada.km) <= tol);
		if (!bate) {
			problemas.push(
				`${citada.km} km não corresponde a nenhum núcleo medido (${reais.map((d) => Math.round(d)).join(", ")})`,
			);
		}
	}
	return { ok: problemas.length === 0, problemas };
}
