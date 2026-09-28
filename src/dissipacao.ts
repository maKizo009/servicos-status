/**
 * Livro da dissipação — o app medindo a própria hipótese do dono.
 *
 * Observação do Dave (27/09/2026): "é comum essas chuvas se dissipar conforme
 * chegam aqui". Havia só impressão visual. Este módulo transforma isso em
 * estatística: cada ciclo grava uma AMOSTRA por núcleo relevante (ex. do radar +
 * a chuva medida na estação naquele momento) e o relatório agrupa as amostras em
 * EPISÓDIOS para responder, com dado do próprio radar:
 *
 *  - quantos núcleos enfraquecem ≥5 dBZ antes de chegar;
 *  - quantos chegam e MOLHAM a estação;
 *  - quantos chegam sem molhar (o caso "virga": eco em altura que evapora);
 *  - quantos somem antes de chegar.
 *
 * Limitação declarada (não esconder): o radar de mosaico mede eco EM ALTURA. Um
 * episódio que "sumiu antes de chegar" pode ser (a) dissipação real, (b) queda
 * abaixo do limiar de detecção ou (c) saída do grid analisado. Por isso o
 * desfecho se chama `sumiu_antes_de_chegar` e não "dissipou" — o dado não
 * distingue os três casos.
 *
 * Tudo aqui é PURO (testável sem banco): agrupamento, desfecho e resumo.
 */

/** Uma linha do livro: um núcleo relevante observado num ciclo. */
export interface AmostraNucleo {
	/** Epoch ms do ciclo que gerou a amostra */
	medidoEm: number;
	lat: number;
	lon: number;
	/** Distância até Ipiranga (km) */
	distKm: number;
	maxDbz: number;
	/** moderate | heavy | extreme */
	intensity: string;
	/** nucleo | area */
	kind: string;
	/** Sem outros núcleos fortes num raio de ISOLAMENTO_KM */
	isolado: boolean | null;
	/** Há quantos frames consecutivos o núcleo aparece */
	framesVivo: number | null;
	/** ΔdBZ em relação ao frame anterior */
	deltaDbz: number | null;
	/** intensificando | estavel | enfraquecendo */
	tendencia: string | null;
	/** approaching | receding | crossing */
	approach: string | null;
	etaMin: number | null;
	/** alert | watch (monitor não entra no livro) */
	zona: string;
	/** Nível do alerta unificado no ciclo */
	nivel: string | null;
	/** Chuva acumulada medida na estação no ciclo (mm) */
	chuva1hMm: number | null;
	chuva6hMm: number | null;
}

/** Ciclos são de ~10 min: duas amostras com mais que isso de intervalo não são o
 * mesmo episódio (o núcleo sumiu e outro surgiu, ou o ciclo falhou). */
export const JANELA_EPISODIO_MIN = 20;
/** Deslocamento máximo entre ciclos para considerar o MESMO núcleo. */
export const RAIO_MESMO_NUCLEO_KM = 60;
/** Distância que conta como "chegou em Ipiranga". */
export const CHEGADA_KM = 25;
/** Chuva que conta como "molhou o chão" (0,2 mm = ruído de balde vazio). */
export const CHUVA_SIGNIFICATIVA_MM = 0.2;
/** Queda de dBZ que conta como enfraquecimento relevante. */
export const QUEDA_RELEVANTE_DBZ = 5;

export type Desfecho =
	| "chegou_e_molhou"
	| "chegou_seco"
	| "dissipou_no_caminho"
	| "sumiu_antes_de_chegar";

export interface Episodio {
	inicioEm: number;
	fimEm: number;
	amostras: number;
	/** Duração em minutos entre a primeira e a última amostra */
	duracaoMin: number;
	dbzInicial: number;
	dbzFinal: number;
	dbzMax: number;
	deltaDbz: number;
	distMinKm: number;
	intensidadeInicial: string;
	intensidadeFinal: string;
	/** Vezes em que o núcleo foi visto isolado / o total de amostras com o dado */
	isoladoEm: number;
	isoladoTotal: number;
	/**
	 * Maior chuva 1h/6h medida na estação durante o episódio — é a evidência de
	 * "molhou o chão". Limitação: chuva de OUTRO sistema no mesmo ciclo conta aqui
	 * (não há atribuição por célula no dado disponível); por isso o relatório fala
	 * em "chuva medida no período do episódio".
	 */
	chuvaNoEpisodioMm: number;
	desfecho: Desfecho;
}

function distanciaKm(
	aLat: number,
	aLon: number,
	bLat: number,
	bLon: number,
): number {
	const R = 6371;
	const p1 = (aLat * Math.PI) / 180;
	const p2 = (bLat * Math.PI) / 180;
	const dp = p2 - p1;
	const dl = ((bLon - aLon) * Math.PI) / 180;
	const h =
		Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
	return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Agrupa amostras em episódios: mesmo núcleo ao longo de ciclos consecutivos.
 *
 * Associação EXCLUSIVA (mesma lição do rastreador de frames): uma amostra entra
 * em NO MÁXIMO um episódio aberto, escolhendo o mais próximo dela. Sem isso, dois
 * núcleos vizinhos alimentariam o mesmo episódio e as estatísticas mentiriam.
 */
export function agruparEpisodios(
	amostras: AmostraNucleo[],
	opts: { janelaMin?: number; raioKm?: number } = {},
): Episodio[] {
	const janelaMin = opts.janelaMin ?? JANELA_EPISODIO_MIN;
	const raioKm = opts.raioKm ?? RAIO_MESMO_NUCLEO_KM;
	const ordenadas = [...amostras].sort((a, b) => a.medidoEm - b.medidoEm);

	type Aberto = { lista: AmostraNucleo[]; ultima: AmostraNucleo };
	const abertos: Aberto[] = [];

	for (const a of ordenadas) {
		let melhor: Aberto | null = null;
		let melhorDist = Number.POSITIVE_INFINITY;
		for (const ep of abertos) {
			// Um episódio aceita NO MÁXIMO uma amostra por ciclo: dois núcleos
			// distintos observados no mesmo ciclo são episódios distintos (sem este
			// gate o segundo cola no episódio do primeiro, que acabou de mudar de
			// posição — a mesma lição da associação exclusiva do rastreador).
			if (a.medidoEm === ep.ultima.medidoEm) continue;
			const gapMin = (a.medidoEm - ep.ultima.medidoEm) / 60_000;
			if (gapMin > janelaMin) continue;
			const d = distanciaKm(a.lat, a.lon, ep.ultima.lat, ep.ultima.lon);
			if (d > raioKm) continue;
			if (d < melhorDist) {
				melhorDist = d;
				melhor = ep;
			}
		}
		if (melhor) {
			melhor.lista.push(a);
			melhor.ultima = a;
		} else {
			abertos.push({ lista: [a], ultima: a });
		}
	}

	return abertos
		.map((ep) => fecharEpisodio(ep.lista))
		.sort((a, b) => a.inicioEm - b.inicioEm);
}

/** Fecha um episódio: agrega e classifica o desfecho. */
export function fecharEpisodio(lista: AmostraNucleo[]): Episodio {
	const primeira = lista[0];
	const ultima = lista[lista.length - 1];
	const dbzInicial = primeira.maxDbz;
	const dbzFinal = ultima.maxDbz;
	const dbzMax = Math.max(...lista.map((a) => a.maxDbz));
	const distMinKm = Math.min(...lista.map((a) => a.distKm));
	const chuvaNoEpisodioMm = Math.max(
		0,
		...lista.map((a) => Math.max(a.chuva1hMm ?? 0, a.chuva6hMm ?? 0)),
	);
	const comIsolado = lista.filter((a) => a.isolado !== null);
	const ep: Episodio = {
		inicioEm: primeira.medidoEm,
		fimEm: ultima.medidoEm,
		amostras: lista.length,
		duracaoMin: Math.round((ultima.medidoEm - primeira.medidoEm) / 60_000),
		dbzInicial,
		dbzFinal,
		dbzMax,
		deltaDbz: dbzFinal - dbzInicial,
		distMinKm,
		intensidadeInicial: primeira.intensity,
		intensidadeFinal: ultima.intensity,
		isoladoEm: comIsolado.filter((a) => a.isolado === true).length,
		isoladoTotal: comIsolado.length,
		chuvaNoEpisodioMm,
		desfecho: "sumiu_antes_de_chegar",
	};
	ep.desfecho = desfechoDoEpisodio(ep);
	return ep;
}

/**
 * Desfecho do episódio, por regra explícita:
 *  - chegou (distMin ≤ CHEGADA_KM) + chuva ≥ CHUVA_SIGNIFICATIVA_MM → molhou
 *  - chegou sem chuva significativa → chegou_seco (o caso "virga")
 *  - não chegou e enfraqueceu (Δ ≤ −QUEDA_RELEVANTE_DBZ ou virou área moderada)
 *    → dissipou_no_caminho
 *  - não chegou e continuou forte → sumiu_antes_de_chegar (dissipação abaixo do
 *    limiar de detecção OU saída do grid: o dado não distingue).
 */
export function desfechoDoEpisodio(ep: Episodio): Desfecho {
	if (ep.distMinKm <= CHEGADA_KM) {
		return ep.chuvaNoEpisodioMm >= CHUVA_SIGNIFICATIVA_MM
			? "chegou_e_molhou"
			: "chegou_seco";
	}
	const enfraqueceu =
		ep.deltaDbz <= -QUEDA_RELEVANTE_DBZ ||
		ep.intensidadeFinal === "moderate" ||
		ep.dbzFinal <= 37;
	return enfraqueceu ? "dissipou_no_caminho" : "sumiu_antes_de_chegar";
}

export interface ResumoDissipacao {
	episodios: number;
	chegaram: number;
	chegouEMolhou: number;
	chegouSeco: number;
	dissipouNoCaminho: number;
	sumiuAntes: number;
	/** % dos episódios em que o núcleo perdeu ≥ QUEDA_RELEVANTE_DBZ */
	pctEnfraqueceu: number;
	/** % dos que chegaram e molharam a estação */
	pctChegouMolhando: number;
	deltaDbzMedio: number;
	dbzMedioNaChegada: number;
	/** Quantos episódios eram de núcleo isolado (entre os que têm o dado) */
	isolados: number;
	isoladosComDado: number;
}

/**
 * Texto do relatório (mesmo conteúdo no script e no endpoint — formatador ÚNICO
 * para não divergir). Pura: recebe episódios + janela, devolve o texto.
 */
export function formatarRelatorioTexto(eps: Episodio[], dias: number): string {
	const r = resumoDissipacao(eps);
	const fmtHora = (ms: number) =>
		new Date(ms).toLocaleString("pt-BR", {
			day: "2-digit",
			month: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			timeZone: "America/Sao_Paulo",
		});
	const linhas: string[] = [
		`📕 Livro da dissipação — últimos ${dias} dias`,
		`   episódios de núcleo: ${r.episodios}`,
	];
	if (r.episodios === 0) {
		linhas.push(
			"   Ainda sem episódios suficientes — o livro começou a gravar agora;",
			"   a estatística fica boa depois de alguns eventos de chuva.",
		);
		return linhas.join("\n");
	}
	linhas.push(
		"",
		"Desfecho:",
		`   chegou e molhou a estação : ${r.chegouEMolhou}`,
		`   chegou seco (eco em altura): ${r.chegouSeco}`,
		`   dissipou no caminho      : ${r.dissipouNoCaminho}`,
		`   sumiu antes de chegar    : ${r.sumiuAntes}`,
		"",
		`   chegaram em Ipiranga (≤${CHEGADA_KM} km): ${r.chegaram}`,
		`   dos que chegaram, molharam: ${r.pctChegouMolhando}%`,
		`   perderam ≥${QUEDA_RELEVANTE_DBZ} dBZ no caminho: ${r.pctEnfraqueceu}%`,
		`   ΔdBZ médio do episódio: ${r.deltaDbzMedio}`,
		`   dBZ médio na chegada: ${r.dbzMedioNaChegada}`,
	);
	if (r.isoladosComDado > 0) {
		linhas.push(
			`   episódios de núcleo ISOLADO: ${r.isolados}/${r.isoladosComDado} (com dado)`,
		);
	}
	linhas.push("", "Episódios (mais recentes primeiro):");
	for (const e of [...eps].reverse().slice(0, 25)) {
		const marcador =
			e.desfecho === "chegou_e_molhou"
				? "💧"
				: e.desfecho === "chegou_seco"
					? "🌫️"
					: e.desfecho === "dissipou_no_caminho"
						? "📉"
						: "❓";
		linhas.push(
			`   ${marcador} ${fmtHora(e.inicioEm)} | ${e.amostras} ciclos (${e.duracaoMin} min) | ` +
				`${e.dbzInicial}→${e.dbzFinal} dBZ (Δ${e.deltaDbz}) | chegou a ${e.distMinKm.toFixed(0)} km | ` +
				`chuva ${e.chuvaNoEpisodioMm} mm | ${e.desfecho}`,
		);
	}
	linhas.push(
		"",
		"⚠️  \"sumiu antes de chegar\" não distingue dissipação real, queda abaixo do",
		"    limiar de detecção e saída do grid (radar mede eco em altura); a chuva é",
		"    contada no PERÍODO do episódio, sem atribuição célula→estação.",
	);
	return linhas.join("\n");
}

/** Números do livro. Função pura: recebe episódios, devolve o resumo. */
export function resumoDissipacao(eps: Episodio[]): ResumoDissipacao {
	const chegadas = eps.filter((e) => e.distMinKm <= CHEGADA_KM);
	const pct = (n: number, total: number) =>
		total === 0 ? 0 : Math.round((n / total) * 1000) / 10;
	return {
		episodios: eps.length,
		chegaram: chegadas.length,
		chegouEMolhou: eps.filter((e) => e.desfecho === "chegou_e_molhou").length,
		chegouSeco: eps.filter((e) => e.desfecho === "chegou_seco").length,
		dissipouNoCaminho: eps.filter((e) => e.desfecho === "dissipou_no_caminho")
			.length,
		sumiuAntes: eps.filter((e) => e.desfecho === "sumiu_antes_de_chegar").length,
		pctEnfraqueceu: pct(
			eps.filter((e) => e.deltaDbz <= -QUEDA_RELEVANTE_DBZ).length,
			eps.length,
		),
		pctChegouMolhando: pct(
			eps.filter((e) => e.desfecho === "chegou_e_molhou").length,
			chegadas.length,
		),
		deltaDbzMedio:
			eps.length === 0
				? 0
				: Math.round(
						(eps.reduce((s, e) => s + e.deltaDbz, 0) / eps.length) * 10,
					) / 10,
		dbzMedioNaChegada:
			chegadas.length === 0
				? 0
				: Math.round(
						(chegadas.reduce((s, e) => s + e.dbzFinal, 0) / chegadas.length) *
							10,
					) / 10,
		isolados: eps.filter((e) => e.isoladoTotal > 0 && e.isoladoEm === e.isoladoTotal)
			.length,
		isoladosComDado: eps.filter((e) => e.isoladoTotal > 0).length,
	};
}
