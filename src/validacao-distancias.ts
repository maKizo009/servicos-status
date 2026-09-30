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
 * - distância citada junto de um MUNICÍPIO da malha → compara com a distância
 *   do CENTRÓIDE da cidade (tolerância máx(25 km, 12%));
 * - distância citada sem cidade → compara com as distâncias REAIS dos núcleos
 *   (`distToTargetKm`, tolerância máx(20 km, 8%)); sem referência nenhuma
 *   (radar limpo), aceita — não há o que contradizer.
 * - "km" sem número (mm, dBZ, h) nunca entra: só `<número> km`.
 *
 * Puro (sem fetch/sem I/O além da malha estática) — testado em
 * scripts/test-distancias.ts.
 */
import MALHA_SUL from "./data/sul-municipios.js";

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
		let cidade: string | null = null;
		for (const e of malha) {
			const nomeNorm = semAcento(e.n);
			if (nomeNorm.length < 4) continue; // "Cruz", "Ipa"... dão match frouxo
			// palavra inteira no trecho anterior (fim do trecho = mais perto do número)
			const idx = antesNorm.lastIndexOf(nomeNorm);
			if (idx < 0) continue;
			const fim = antesNorm.slice(idx + nomeNorm.length);
			if (/[a-z0-9]/.test(fim.slice(0, 1))) continue; // casa prefixo, não palavra
			cidade = e.n;
			break;
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
 * Valida cada distância citada contra a referência certa (cidade OU núcleo).
 * `distanciasReaisKm` = `distToTargetKm` das entidades do nowcast.
 */
export function avaliarDistanciasCitadas(
	text: string,
	distanciasReaisKm: number[],
	alvo: { lat: number; lon: number } = ALVO,
): ResultadoDistancias {
	const problemas: string[] = [];
	const reais = distanciasReaisKm.filter((d) => Number.isFinite(d) && d > 0);
	for (const citada of extrairDistanciasCitadas(text)) {
		if (citada.cidade) {
			const dCidade = distanciaMunicipioKm(citada.cidade, alvo);
			if (dCidade == null) continue; // cidade fora da malha — não dá p/ julgar
			const tol = Math.max(25, citada.km * 0.12);
			if (Math.abs(dCidade - citada.km) > tol) {
				problemas.push(
					`"${citada.cidade} a ${citada.km} km" não bate com a distância da cidade (${Math.round(dCidade)} km)`,
				);
			}
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
