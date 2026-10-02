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
 *   CENTRÓIDE da cidade (tolerância máx(25 km, 12%)) OU com a distância de uma
 *   ENTIDADE real do nowcast (tolerância máx(20 km, 8%)); primeiro tenta o
 *   rótulo municipal pareado, mas mantém a distância medida se o núcleo cruzou
 *   a fronteira e a malha mudou o rótulo entre ciclos;
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
	/**
	 * Município da malha pareado com a distância: citado ANTES do número
	 * ("área em X, a N km" — ordem do template) ou DEPOIS com preposição
	 * locativa ("a N km em X" — ordem livre do VLM, caso real 01/10/2026).
	 * null = sem cidade (compara só com entidades medidas).
	 */
	cidade: string | null;
}

/**
 * Extrai as distâncias citadas (`<número> km`) com a cidade associada.
 * "22,6 mm", "38 dBZ", "12 h" NÃO são distâncias e não entram.
 */
export function extrairDistanciasCitadas(text: string): DistanciaCitada[] {
	const achados: DistanciaCitada[] = [];
	const re = /(\d+(?:[.,]\d+)?)\s*km\b(?!\s*\/\s*h)/gi;
	const malha = MALHA_SUL as unknown as EntradaMalha[];
	let m: RegExpExecArray | null;
	while ((m = re.exec(text)) !== null) {
		const km = Number(m[1]?.replace(",", "."));
		if (!Number.isFinite(km) || km <= 0) continue;
		// Janela ANTES também corta em fim de frase (espelho do corte da
		// janela DEPOIS): a cidade da frase ANTERIOR não pareia com o
		// número desta. Caso real 02/10/2026 (nvidia_nim): "Não há chuva
		// registrada em Ipiranga. Há uma área de chuva moderada a 336 km
		// em Álvaro de Carvalho/SP" — "Ipiranga" (frase anterior) entrava
		// na janela de 45 chars e roubava o pareamento; a citação CORRETA
		// (centróide de Álvaro de Carvalho = 337,9 km, Δ1,9) caía na
		// comparação errada ("Ipiranga a 336 km" × centróide 3 km) →
		// falso alarme distancia_inconsistente no vigia sempre que o
		// texto era fresco e o núcleo citado já tinha saido da lista de
		// threats (turnover de radar).
		const antesBruto = text.slice(Math.max(0, m.index - 45), m.index);
		let corteAntes = -1;
		for (const fimDeFrase of [".", "!", "?", "…"]) {
			const i = antesBruto.lastIndexOf(fimDeFrase);
			if (i > corteAntes) corteAntes = i;
		}
		const antes =
			corteAntes >= 0 ? antesBruto.slice(corteAntes + 1) : antesBruto;
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
		// Cidade DEPOIS do número ("a 327 km em Planaltina do Paraná") — ordem
		// comum no texto livre do VLM (o template usa "área em X, a N km", mas
		// o modelo inverte). Causa raiz do falso alarme 01/10/2026: o extrator
		// só olhava ANTES do número, a citação ficava "sem cidade" e caía na
		// comparação com núcleos medidos — a chuva em Planaltina era moderada
		// (fora do limiar de threat) e nenhum núcleo ficava a ~327 km. A
		// métrica certa desta frase é a da CIDADE (centróide 320 km, Δ7 ≪
		// tolerância). Só pareia com preposição LOCATIVA (em/no/na/nos/nas/
		// até/próximo a/perto de): "477 km de Ipiranga" é referência do alvo,
		// não local da chuva — vira null. Janela de 45 chars corta em fim de
		// frase; vence o nome que COMEÇA mais perto do número (empate → mais
		// longo, palavra inteira dos dois lados).
		if (cidade === null) {
			const depoisBruto = text.slice(
				m.index + m[0].length,
				m.index + m[0].length + 45,
			);
			const corte = depoisBruto.search(/[.!?…]/);
			const depois = corte >= 0 ? depoisBruto.slice(0, corte) : depoisBruto;
			const depoisNorm = semAcento(depois);
			let inicioMaisProximo = Number.MAX_SAFE_INTEGER;
			let nomeDepoisNorm = "";
			for (const e of malha) {
				const nomeNorm = semAcento(e.n);
				if (nomeNorm.length < 4) continue; // "Cruz", "Ipa"... dão match frouxo
				const idx = depoisNorm.indexOf(nomeNorm);
				if (idx < 0) continue;
				const antesDoIdx = depoisNorm.slice(Math.max(0, idx - 1), idx);
				if (/[a-z0-9]/.test(antesDoIdx)) continue; // casa sufixo, não palavra
				const fim = depoisNorm.slice(idx + nomeNorm.length);
				if (/[a-z0-9]/.test(fim.slice(0, 1))) continue; // casa prefixo, não palavra
				// preposição locativa imediatamente antes do nome ("em Piên")
				const entre = depoisNorm.slice(Math.max(0, idx - 14), idx);
				if (
					!/(?:^|[^a-z])(?:nos|nas|no|na|em|ate|proximo a|perto de)\s+$/.test(
						entre,
					)
				)
					continue;
				const vence =
					idx < inicioMaisProximo ||
					(idx === inicioMaisProximo &&
						nomeNorm.length > nomeDepoisNorm.length);
				if (vence) {
					inicioMaisProximo = idx;
					nomeDepoisNorm = nomeNorm;
					cidade = e.n;
				}
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
 *
 * Usado pelo watchdog externo (/root/Scripts/BunJS/servicos-status-boletim-watchdog).
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
 *   distância de qualquer ENTIDADE medida (distToTargetKm). Primeiro tenta
 *   validar com entidade rotulada pelo mesmo município; se o rótulo mudou na
 *   fronteira entre ciclos, a distância da entidade continua sendo evidência.
 *   Entidade sem rótulo também serve neste fallback, mas nunca valida sozinha
 *   uma citação com cidade se o número não bater com a entidade;
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
			const bateEntidadePareada = refs.some(
				(r) =>
					r.municipio != null &&
					semAcento(r.municipio) === citadaNorm &&
					Math.abs(r.km - citada.km) <= tolEntidade,
			);
			// A malha municipal pode mudar o rótulo de um mesmo núcleo quando
			// ele cruza a fronteira entre municípios em ciclos consecutivos.
			// Se a distância bate com uma entidade real, preserve a métrica mesmo
			// quando o rótulo atual já não é o da cidade citado no boletim.
			const bateAlgumaEntidade = refs.some(
				(r) => Math.abs(r.km - citada.km) <= tolEntidade,
			);
			if (bateCidade || bateEntidadePareada || bateAlgumaEntidade) continue;
			if (dCidade == null && reais.length === 0) continue; // sem nada p/ julgar
			problemas.push(
				`"${citada.cidade} a ${citada.km} km" não bate com a distância da cidade (${dCidade != null ? Math.round(dCidade) : "fora da malha"}) nem com nenhuma entidade medida (${refs.map((r) => `${Math.round(r.km)} km${r.municipio ? `@${r.municipio}` : ""}`).join("; ") || "nenhuma"})`,
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
