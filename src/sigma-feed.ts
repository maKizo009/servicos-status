/**
 * Feed de estações do Sigma Meteorologia — 30+ redes em UM formato.
 *
 * Por que existe: as fontes "fechadas" têm caminho alternativo aqui.
 *  - WUNDERGROUND: a API oficial PWS é restrita/paga, mas o Sigma PUBLICA o
 *    feed do WU como arquivo estático — medido com 5-6 min de frescor
 *    (22:31 no arquivo com o relógio em 22:37), 120 estações no PR.
 *  - SIMEPAR: o site é Cloudflare (skill antiga dizia "descartada"), mas aqui
 *    aparecem 47 estações do PR com rajada e chuva.
 *  - CEMADEN: o getJson2 público NÃO traz coordenada (só codibge); o arquivo
 *    do Sigma traz lat/lon exatos → permite seleção geométrica de corredor.
 *
 * ⚠️ SÓ SOB DEMANDA (regra do Dave 21/09/2026): não fazer polling. O ciclo só
 * bate no site deles quando há NÚCLEO DE CHUVA perto de uma cidade do
 * corredor — é quando dado de solo importa (severidade: rajada, queda de
 * pressão, acumulado). Fora disso, zero requisições.
 *
 * Não é API oficial: é leitura de arquivo público de site comercial. O layout
 * já mudou uma vez (comentário "A MÁGICA FOI ALTERADA AQUI" no JS deles). Por
 * isso todo parse passa por `validarSanidade()` e degrada para null em vez de
 * entregar número errado.
 */

const BASE = "https://sigmameteorologia.com";
const PAGINA = `${BASE}/nowcasting/`;
const REQUEST_TIMEOUT_MS = 8_000;
/** O WAF deles devolve 403 sem UA completo (UA curto cai no bloqueio). */
const UA_BROWSER =
	"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";

/** Redes com valor para o corredor de Ipiranga (o Sigma tem 30+, não precisamos de todas). */
export const SIGMA_REDES = ["wu", "simepar", "inmet", "cemaden"] as const;
export type SigmaRede = (typeof SIGMA_REDES)[number];

/** Sentinel de "sem dado" no arquivo. NUNCA virar 0 (0 = "não choveu"). */
const SEM_DADO = -999.9;

/**
 * Mapa de colunas POSICIONAIS, extraído do `getPopup()` do próprio site
 * (não adivinhado) e validado ao vivo em 21/09/2026.
 */
const COL = {
	lat: 0,
	lon: 1,
	id: 2,
	atualizacao: 3,
	tempC: 4,
	umidadePct: 7,
	orvalhoC: 10,
	ventoKmh: 16,
	ventoDirDeg: 17,
	rajada1hKmh: 18,
	chuva1hMm: 20,
	chuva24hMm: 21,
	rajada24hKmh: 30,
	nome: 31,
	pressaoMax24Hpa: 34,
	pressaoMin24Hpa: 35,
	pressaoAtualHpa: 36,
	/** UF em índice fixo (medido: 40 em todas as 4 redes) */
	uf: 40,
	/** Rede/fonte em índice fixo (medido: 41 em todas as 4 redes) */
	rede: 41,
	acumuladoAtual: 44,
	/**
	 * Nível do rio (s[45] no getPopup deles). Os arquivos horários das 4
	 * redes testadas têm 45 tokens (0..44) → normalmente vem ausente e vira
	 * null. Mantido porque o índice é oficial e pode aparecer em outra rede.
	 */
	nivelRioM: 45,
} as const;

/** Frescor máximo aceitável para DECISÃO (mesma lógica do CEMADEN: stale ≠ sem chuva). */
export const SIGMA_FRESCOR_MAX_MIN = 90;

/**
 * Raio (km) para considerar que um núcleo de chuva está "na cidade" — dispara
 * a consulta ao feed. 40 km ≈ uma hora de deslocamento típico de célula.
 */
export const SIGMA_RAIO_CIDADE_KM = 40;

export interface SigmaEstacao {
	lat: number;
	lon: number;
	id: string;
	/** Atualização como vem no arquivo (horário local UTC-3, "AAAA-MM-DD HH:MM") */
	atualizacao: string;
	/** Minutos desde a atualização (null se não parsear) */
	frescorMin: number | null;
	nome: string;
	uf: string;
	rede: string;
	tempC: number | null;
	umidadePct: number | null;
	ventoKmh: number | null;
	ventoDirDeg: number | null;
	/** Rajada da ÚLTIMA HORA (km/h) */
	rajada1hKmh: number | null;
	chuva1hMm: number | null;
	chuva24hMm: number | null;
	rajada24hKmh: number | null;
	pressaoAtualHpa: number | null;
	pressaoMax24Hpa: number | null;
	pressaoMin24Hpa: number | null;
	/**
	 * Queda de pressão em 24 h (máx − atual), em hPa. Positivo = caiu.
	 * Como é calculada DENTRO da mesma estação, o problema de PWS com pressão
	 * não calibrada (medido: 915,5 e 1010,5 hPa na MESMA cidade) desaparece —
	 * não importa a pressão absoluta, só a própria série. É o indicador de
	 * "queda brusca" que o Dave pediu.
	 */
	quedaPressao24Hpa: number | null;
	nivelRioM: number | null;
	/** Estação parada (frescor > SIGMA_FRESCOR_MAX_MIN) */
	stale: boolean;
}

function num(tokens: string[], idx: number): number | null {
	const v = Number(tokens[idx]);
	if (!Number.isFinite(v) || v === SEM_DADO) return null;
	return v;
}

/** "AAAA-MM-DD HH:MM" (horário LOCAL UTC-3) → epoch ms. null se não parsear. */
export function localParaEpoch(ts: string): number | null {
	const m = ts.match(/^(\d{4})-(\d{2})-(\d{2})[ _](\d{2}):(\d{2})$/);
	if (!m) return null;
	const [, y, mo, d, h, mi] = m;
	// O arquivo é em horário local (UTC-3, sem DST no BR desde 2019).
	return Date.UTC(
		Number(y),
		Number(mo) - 1,
		Number(d),
		Number(h) + 3,
		Number(mi),
	);
}

/**
 * Valida a coerência dos extremos de pressão: a atual TEM que ficar entre o
 * mínimo e o máximo das 24 h. Teste de falsificação rodado em 21/09/2026:
 * 4/4 estações fecharam com s[34]=máx / s[35]=mín; a leitura invertida
 * falharia 4/4. Se falhar, o layout mudou → descarta os extremos (e a queda)
 * em vez de entregar número inventado.
 */
export function validarSanidade(est: {
	pressaoAtualHpa: number | null;
	pressaoMax24Hpa: number | null;
	pressaoMin24Hpa: number | null;
}): boolean {
	const { pressaoAtualHpa: at, pressaoMax24Hpa: mx, pressaoMin24Hpa: mn } = est;
	if (at == null || mx == null || mn == null) return true; // sem dado não é inconsistência
	// 1 hPa de tolerância (arredondamento de décimo no arquivo).
	return at <= mx + 1 && at >= mn - 1;
}

/** Uma linha do arquivo → estação. null se a linha não for de estação. */
export function parseSigmaLinha(
	linha: string,
	agoraMs: number = Date.now(),
): SigmaEstacao | null {
	const t = linha.trim().split(/\s+/);
	if (t.length < 32) return null;
	const lat = Number(t[COL.lat]);
	const lon = Number(t[COL.lon]);
	if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

	// Nome = primeiro token com "_-_" (ou terminado em "(N m)").
	const nome =
		t.find((x) => x.endsWith(")") && x.includes("_")) ?? t[COL.nome] ?? "?";
	// UF e REDE ficam em índice FIXO (40/41) — medido nas 4 redes (WU,
	// SIMEPAR, INMET, CEMADEN): todas com 45 tokens e o nome no 31. Guarda:
	// se não parecer nome de UF (número/sentinela), marca "?" em vez de
	// entregar lixo. O teste ao vivo (contagem de estações no PR) denuncia
	// qualquer mudança de layout.
	const ufTok = t[40];
	const redeTok = t[41];
	const pareceTexto = (s: string | undefined) =>
		s != null && s !== "-" && s !== "-999.9" && !/^-?\d/.test(s);
	const uf = pareceTexto(ufTok) ? ufTok.replace(/_/g, " ") : "?";
	const rede = pareceTexto(redeTok) ? redeTok : "?";

	const atualizacao = (t[COL.atualizacao] ?? "").replace("_", " ");
	const epoch = localParaEpoch(atualizacao);
	const frescorMin =
		epoch == null ? null : Math.round((agoraMs - epoch) / 60_000);

	const pressaoAtualHpa = num(t, COL.pressaoAtualHpa);
	const pressaoMax24Hpa = num(t, COL.pressaoMax24Hpa);
	const pressaoMin24Hpa = num(t, COL.pressaoMin24Hpa);
	const coerente = validarSanidade({
		pressaoAtualHpa,
		pressaoMax24Hpa,
		pressaoMin24Hpa,
	});

	const est: SigmaEstacao = {
		lat,
		lon,
		id: t[COL.id] ?? "?",
		atualizacao,
		frescorMin,
		nome: nome.replace(/_/g, " "),
		uf,
		rede,
		tempC: num(t, COL.tempC),
		umidadePct: num(t, COL.umidadePct),
		ventoKmh: num(t, COL.ventoKmh),
		ventoDirDeg: num(t, COL.ventoDirDeg),
		rajada1hKmh: num(t, COL.rajada1hKmh),
		chuva1hMm: num(t, COL.chuva1hMm),
		chuva24hMm: num(t, COL.chuva24hMm),
		rajada24hKmh: num(t, COL.rajada24hKmh),
		pressaoAtualHpa,
		pressaoMax24Hpa: coerente ? pressaoMax24Hpa : null,
		pressaoMin24Hpa: coerente ? pressaoMin24Hpa : null,
		quedaPressao24Hpa:
			coerente && pressaoMax24Hpa != null && pressaoAtualHpa != null
				? Math.round((pressaoMax24Hpa - pressaoAtualHpa) * 10) / 10
				: null,
		nivelRioM: num(t, COL.nivelRioM),
		stale: frescorMin != null && frescorMin > SIGMA_FRESCOR_MAX_MIN,
	};
	return est;
}

/** Cookie do WAF (o arquivo de dados dá 403 sem ele + Referer). */
let cookieCache: { valor: string; em: number } | null = null;

async function obterCookie(forcar = false): Promise<string | null> {
	if (!forcar && cookieCache && Date.now() - cookieCache.em < 30 * 60_000) {
		return cookieCache.valor;
	}
	try {
		const r = await fetch(PAGINA, {
			headers: { "user-agent": UA_BROWSER, accept: "text/html" },
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
		const raw = r.headers.getSetCookie?.() ?? [];
		const cookie = raw.map((c) => c.split(";")[0]).join("; ");
		cookieCache = { valor: cookie, em: Date.now() };
		return cookie;
	} catch {
		return null;
	}
}

/** Caminho do arquivo: hora LOCAL (UTC-3), um arquivo por rede por hora. */
export function caminhoArquivo(rede: SigmaRede, agora: Date): string {
	const local = new Date(agora.getTime() - 3 * 60 * 60_000);
	const y = local.getUTCFullYear();
	const mo = String(local.getUTCMonth() + 1).padStart(2, "0");
	const d = String(local.getUTCDate()).padStart(2, "0");
	const h = String(local.getUTCHours()).padStart(2, "0");
	return `/produtos/${rede}/${y}-${mo}-${d}/${h}00.txt`;
}

export interface SigmaResultado {
	rede: SigmaRede;
	/** Caminho efetivamente baixado (null se todas as tentativas falharam) */
	arquivo: string | null;
	estacoes: SigmaEstacao[];
	erro?: string;
}

/**
 * Baixa UMA rede. Tenta a hora atual e, se 404, até 2 horas para trás (o
 * arquivo da hora corrente leva alguns minutos para aparecer).
 */
export async function fetchSigmaRede(
	rede: SigmaRede,
	agora: Date = new Date(),
): Promise<SigmaResultado> {
	const tentativas: string[] = [];
	let cookie = await obterCookie();
	for (let atras = 0; atras <= 2; atras++) {
		const quando = new Date(agora.getTime() - atras * 60 * 60_000);
		const caminho = caminhoArquivo(rede, quando);
		const url = `${BASE}${caminho}`;
		tentativas.push(caminho);
		try {
			let r = await fetch(url, {
				headers: {
					"user-agent": UA_BROWSER,
					referer: PAGINA,
					accept: "text/plain,*/*",
					...(cookie ? { cookie } : {}),
				},
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			});
			if (r.status === 403) {
				// WAF: cookie venceu — renova uma vez e repete.
				cookie = await obterCookie(true);
				r = await fetch(url, {
					headers: {
						"user-agent": UA_BROWSER,
						referer: PAGINA,
						accept: "text/plain,*/*",
						...(cookie ? { cookie } : {}),
					},
					signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
				});
			}
			if (!r.ok) continue;
			const texto = await r.text();
			const estacoes = texto
				.split("\n")
				.map((l) => parseSigmaLinha(l, agora.getTime()))
				.filter((e): e is SigmaEstacao => e != null);
			if (estacoes.length === 0) continue;
			return { rede, arquivo: caminho, estacoes };
		} catch (err) {
			return { rede, arquivo: null, estacoes: [], erro: String(err) };
		}
	}
	return {
		rede,
		arquivo: null,
		estacoes: [],
		erro: `nenhum arquivo disponível (tentei ${tentativas.join(", ")})`,
	};
}

/** Distância haversine em km. */
export function haversineKm(
	lat1: number,
	lon1: number,
	lat2: number,
	lon2: number,
): number {
	const R = 6371;
	const p1 = (lat1 * Math.PI) / 180;
	const p2 = (lat2 * Math.PI) / 180;
	const dp = p2 - p1;
	const dl = ((lon2 - lon1) * Math.PI) / 180;
	const a =
		Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
	return 2 * R * Math.asin(Math.sqrt(a));
}

/** Estações dentro de `maxKm` do ponto, ordenadas por distância. */
export function estacoesProximas(
	estacoes: SigmaEstacao[],
	lat: number,
	lon: number,
	maxKm: number,
): (SigmaEstacao & { distanciaKm: number })[] {
	return estacoes
		.map((e) => ({ ...e, distanciaKm: haversineKm(lat, lon, e.lat, e.lon) }))
		.filter((e) => e.distanciaKm <= maxKm)
		.sort((a, b) => a.distanciaKm - b.distanciaKm);
}

/**
 * GATE (regra do Dave): só vale a pena bater no Sigma quando há NÚCLEO DE
 * CHUVA perto de uma cidade do corredor. Recebe os núcleos já detectados pelo
 * radar (com distância ao alvo) e a lista de cidades, e devolve as cidades
 * "quentes" — vazio = nenhuma requisição ao site deles.
 */
export function cidadesComNucleo(
	nucleos: { lat: number; lon: number }[],
	cidades: { nome: string; lat: number; lon: number }[],
	raioKm = 40,
): { nome: string; lat: number; lon: number; distanciaKm: number }[] {
	const quentes: {
		nome: string;
		lat: number;
		lon: number;
		distanciaKm: number;
	}[] = [];
	for (const c of cidades) {
		let melhor = Infinity;
		for (const n of nucleos) {
			const d = haversineKm(n.lat, n.lon, c.lat, c.lon);
			if (d < melhor) melhor = d;
		}
		if (melhor <= raioKm) {
			quentes.push({ ...c, distanciaKm: Math.round(melhor * 10) / 10 });
		}
	}
	return quentes.sort((a, b) => a.distanciaKm - b.distanciaKm);
}

/**
 * Cidades do corredor de Ipiranga (lista do Dave 21/09/2026 + as que têm
 * estação a ≤60 km medidas no arquivo). Coordenadas: centro municipal (IBGE).
 */
export const CIDADES_CORREDOR = [
	{ nome: "Ipiranga", lat: -25.0244, lon: -50.5847 },
	{ nome: "Ivaí", lat: -25.0108, lon: -50.8578 },
	{ nome: "Irati", lat: -25.4672, lon: -50.6511 },
	{ nome: "Imbituva", lat: -25.2294, lon: -50.6053 },
	{ nome: "Prudentópolis", lat: -25.2131, lon: -50.9778 },
	{ nome: "Guarapuava", lat: -25.3905, lon: -51.4626 },
	{ nome: "Rio Azul", lat: -25.7333, lon: -50.7964 },
	{ nome: "Ponta Grossa", lat: -25.0916, lon: -50.1668 },
	{ nome: "Tibagi", lat: -24.5103, lon: -50.4136 },
	{ nome: "Teixeira Soares", lat: -25.3711, lon: -50.4594 },
	{ nome: "Castro", lat: -24.7893, lon: -50.0117 },
	{ nome: "Curitiba", lat: -25.4284, lon: -49.2733 },
] as const;

/** Resumo de solo de uma cidade: o que decide severidade (rajada, pressão, chuva). */
export interface SoloCidade {
	cidade: string;
	distanciaKm: number;
	estacao: string;
	rede: string;
	atualizacao: string;
	frescorMin: number | null;
	stale: boolean;
	rajada1hKmh: number | null;
	rajada24hKmh: number | null;
	quedaPressao24Hpa: number | null;
	chuva1hMm: number | null;
	chuva24hMm: number | null;
	ventoKmh: number | null;
	ventoDirDeg: number | null;
}

/**
 * Melhor estação (a mais fresca com dado útil) por cidade quente.
 * Prioriza quem tem rajada/pressão/chuva e não está parada.
 */
export function resumoSolo(
	quentes: { nome: string; lat: number; lon: number; distanciaKm: number }[],
	porRede: SigmaResultado[],
	raioKm = 40,
): SoloCidade[] {
	const todas = porRede.flatMap((r) => r.estacoes);
	const out: SoloCidade[] = [];
	for (const c of quentes) {
		const perto = estacoesProximas(todas, c.lat, c.lon, raioKm).filter(
			(e) => !e.stale,
		);
		if (perto.length === 0) continue;
		const pontuar = (e: SigmaEstacao) =>
			(e.rajada1hKmh != null ? 2 : 0) +
			(e.quedaPressao24Hpa != null ? 2 : 0) +
			(e.chuva1hMm != null ? 1 : 0) +
			(e.chuva24hMm != null ? 1 : 0);
		perto.sort(
			(a, b) => pontuar(b) - pontuar(a) || a.distanciaKm - b.distanciaKm,
		);
		const e = perto[0];
		out.push({
			cidade: c.nome,
			distanciaKm: Math.round(e.distanciaKm * 10) / 10,
			estacao: e.nome,
			rede: e.rede,
			atualizacao: e.atualizacao,
			frescorMin: e.frescorMin,
			stale: e.stale,
			rajada1hKmh: e.rajada1hKmh,
			rajada24hKmh: e.rajada24hKmh,
			quedaPressao24Hpa: e.quedaPressao24Hpa,
			chuva1hMm: e.chuva1hMm,
			chuva24hMm: e.chuva24hMm,
			ventoKmh: e.ventoKmh,
			ventoDirDeg: e.ventoDirDeg,
		});
	}
	return out;
}
