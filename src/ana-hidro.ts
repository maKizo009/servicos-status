/**
 * ANA Hidro — triangulação fluviométrica para o Monitor Ipiranga.
 *
 * Ipiranga/PR (900 km², bacia do Tibagi/Bitumirim) NÃO tem estação
 * fluviométrica ativa dentro da malha — confirmado no HidroWeb/IAT.
 * A saída é triangular com 3 sentinelas telemétricas na calha do
 * Rio Tibagi que cercam o município.
 *
 * Fonte pública: telemetriaws1.ana.gov.br/ServiceANA.asmx
 * Método: DadosHidrometeorologicos (sem auth, XML).
 * Cada sentinela retorna série horária com Nivel (cm), Vazao (m³/s) e Chuva (mm).
 *
 * Integrado no mesmo cron de 10 min (api/cron → syncWeatherCycle) e
 * exposto no WeatherState.hidro + /llms.txt + /api/hidro.
 */

const REQUEST_TIMEOUT_MS = 15_000;

// 3 sentinelas na calha do Tibagi — cercam Ipiranga a ~30-80 km.
// Código ANA, nome humano e papel na triangulação.
export const SENTINELAS = [
	{
		codigo: "64491000",
		nome: "Ribeirão das Antas (UHE Gov. Jayme Canet Junior jusante)",
		rio: "Tibagi",
		papel: "Montante — influência de vazão liberada (efeito Mauá)",
		municipio: "Telêmaco Borba",
	},
	{
		codigo: "64504210",
		nome: "Cebolão",
		rio: "Tibagi",
		papel: "Central — nível do Tibagi na região de Ponta Grossa/Castro",
		municipio: "Castro",
	},
	{
		codigo: "64507000",
		nome: "Jataizinho (UHE Capivara)",
		rio: "Tibagi",
		papel: "Jusante — velocidade de escoamento após Ipiranga",
		municipio: "Jataizinho",
	},
] as const;

export interface HidroSeriePonto {
	dataHora: string; // "2026-08-26 20:00:00" (horário da ANA, BRT)
	nivelCm: number | null; // cm
	vazaoM3s: number | null;
	chuvaMm: number | null;
}

export interface HidroEstacao {
	codigo: string;
	nome: string;
	rio: string;
	municipio: string;
	papel: string;
	/** Leitura mais recente */
	nivelCm: number | null;
	vazaoM3s: number | null;
	chuvaMm: number | null;
	dataHora: string | null;
	/** Série das últimas ~24 h (horária) quando disponível */
	serie: HidroSeriePonto[];
	/** Δ nível nas últimas 6 h (cm), null se sem histórico suficiente */
	delta6hCm: number | null;
	erro?: string | null;
}

export interface HidroState {
	estacoes: HidroEstacao[];
	fonte: string;
	atualizadoEm: number | null;
	erro?: string | null;
	/** Avaliação rápida — usada no llms.txt e alertas */
	riscoEnxurrada: "ok" | "warn" | "critical";
	riscoCheia: "ok" | "watch" | "critical";
	/** Texto curto para o llms.txt */
	resumoRisco: string;
}

function parseNum(v: string | null | undefined): number | null {
	if (v == null || v === "") return null;
	const n = Number(String(v).replace(",", "."));
	return Number.isFinite(n) ? n : null;
}

function parseXmlDados(xml: string): HidroSeriePonto[] {
	// Extrai cada <DadosHidrometereologicos> ... </DadosHidrometereologicos>
	const re =
		/<DadosHidrometereologicos[^>]*>([\s\S]*?)<\/DadosHidrometereologicos>/g;
	const pontos: HidroSeriePonto[] = [];
	let m: RegExpExecArray | null;
	while ((m = re.exec(xml))) {
		const block = m[1];
		const get = (tag: string) => {
			const r = new RegExp(`<${tag}>([^<]*)</${tag}>`);
			const mm = r.exec(block);
			return mm ? mm[1].trim() : null;
		};
		const dataHora = get("DataHora");
		if (!dataHora) continue;
		pontos.push({
			dataHora,
			nivelCm: parseNum(get("Nivel")),
			vazaoM3s: parseNum(get("Vazao")),
			chuvaMm: parseNum(get("Chuva")),
		});
	}
	// Ordena por dataHora desc (mais recente primeiro — API já vem assim)
	return pontos;
}

async function fetchEstacao(
	codigo: string,
	nome: string,
	rio: string,
	municipio: string,
	papel: string,
): Promise<HidroEstacao> {
	const hoje = new Date();
	const ontem = new Date(Date.now() - 24 * 3600 * 1000);
	const fmt = (d: Date) =>
		`${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
	const dataInicio = fmt(ontem);
	const dataFim = fmt(hoje);
	const url = `https://telemetriaws1.ana.gov.br/ServiceANA.asmx/DadosHidrometeorologicos?codEstacao=${codigo}&dataInicio=${dataInicio}&dataFim=${dataFim}`;

	try {
		const res = await fetch(url, {
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			headers: { Accept: "application/xml" },
		});
		if (!res.ok) {
			return {
				codigo,
				nome,
				rio,
				municipio,
				papel,
				nivelCm: null,
				vazaoM3s: null,
				chuvaMm: null,
				dataHora: null,
				serie: [],
				delta6hCm: null,
				erro: `HTTP ${res.status}`,
			};
		}
		const xml = await res.text();
		if (xml.includes("<ErrorTable") || xml.includes("Sem dados")) {
			return {
				codigo,
				nome,
				rio,
				municipio,
				papel,
				nivelCm: null,
				vazaoM3s: null,
				chuvaMm: null,
				dataHora: null,
				serie: [],
				delta6hCm: null,
				erro: "Sem dados no período",
			};
		}
		const serie = parseXmlDados(xml);
		if (serie.length === 0) {
			return {
				codigo,
				nome,
				rio,
				municipio,
				papel,
				nivelCm: null,
				vazaoM3s: null,
				chuvaMm: null,
				dataHora: null,
				serie: [],
				delta6hCm: null,
				erro: "Série vazia",
			};
		}
		const latest = serie[0];
		// Δ 6 h: compara mais recente com a de ~6 h atrás (índice 6 se horário)
		let delta6hCm: number | null = null;
		if (serie.length >= 7 && latest.nivelCm != null) {
			const ponto6h = serie.find((p) => p.nivelCm != null && p !== latest);
			// pega o ponto ~6 posições atrás que tenha nível
			let idx = 6;
			while (idx < serie.length && serie[idx].nivelCm == null) idx++;
			if (idx < serie.length && serie[idx].nivelCm != null) {
				delta6hCm = latest.nivelCm - (serie[idx].nivelCm as number);
			}
		}
		return {
			codigo,
			nome,
			rio,
			municipio,
			papel,
			nivelCm: latest.nivelCm,
			vazaoM3s: latest.vazaoM3s,
			chuvaMm: latest.chuvaMm,
			dataHora: latest.dataHora,
			serie: serie.slice(0, 24),
			delta6hCm,
			erro: null,
		};
	} catch (e: unknown) {
		const msg = e instanceof Error ? e.message : String(e);
		return {
			codigo,
			nome,
			rio,
			municipio,
			papel,
			nivelCm: null,
			vazaoM3s: null,
			chuvaMm: null,
			dataHora: null,
			serie: [],
			delta6hCm: null,
			erro: msg,
		};
	}
}

function avaliarRisco(
	estacoes: HidroEstacao[],
	cemadenAcc6hMax: number | null,
): Pick<HidroState, "riscoEnxurrada" | "riscoCheia" | "resumoRisco"> {
	// Triangulação é referência regional (Ipiranga NÃO tem estação
	// fluviométrica própria — o Bitumirim não é medido direto). Por isso a
	// classificação automática é CONSERVADORA: só sobe para "watch" com
	// evidência convergente (rio subindo + chuva medida aqui e na sentinela).
	// "critical" nunca é gerado aqui — cheia se confirma pela Defesa Civil/IAT.
	const comDados = estacoes.filter((e) => !e.erro && e.nivelCm != null);
	if (comDados.length === 0) {
		return {
			riscoEnxurrada: "ok",
			riscoCheia: "ok",
			resumoRisco:
				"Triangulação indisponível no momento (sentinelas sem dados). Ipiranga não possui estação fluviométrica própria — para alertas oficiais, siga Defesa Civil e IAT.",
		};
	}
	const fmtDelta = (d: number | null) =>
		d == null
			? "sem histórico 6h"
			: `${d > 0 ? "subindo" : d < 0 ? "descendo" : "estável"} (${d > 0 ? "+" : ""}${(d / 100).toFixed(2).replace(".", ",")} m/6h)`;
	const trechos = comDados.map((e) => {
		const nomeCurto = e.nome.split(" (")[0];
		const chuva =
			e.chuvaMm != null
				? `, chuva ${e.chuvaMm.toFixed(1).replace(".", ",")} mm/h no local`
				: "";
		return `${nomeCurto}: ${((e.nivelCm as number) / 100).toFixed(2).replace(".", ",")} m (${fmtDelta(e.delta6hCm)}${chuva})`;
	});
	const subindoForte = comDados.some((e) => (e.delta6hCm ?? 0) >= 30);
	const chuvaSentinela = Math.max(0, ...comDados.map((e) => e.chuvaMm ?? 0));
	const chuvaLocal = cemadenAcc6hMax ?? 0;
	// Watch: rio subindo ≥30 cm/6h, ou chuva forte convergente (aqui + lá).
	const watch = subindoForte || (chuvaLocal >= 15 && chuvaSentinela >= 10);
	const motivo = subindoForte
		? "nível subindo ≥30 cm em 6h em ao menos uma sentinela"
		: chuvaLocal >= 15 && chuvaSentinela >= 10
			? `chuva convergente (${chuvaLocal.toFixed(1).replace(".", ",")} mm/6h em Ipiranga + ${chuvaSentinela.toFixed(1).replace(".", ",")} mm/h na sentinela)`
			: null;
	return {
		riscoEnxurrada: watch ? "warn" : "ok",
		riscoCheia: watch ? "watch" : "ok",
		resumoRisco:
			`Triangulação no Rio Tibagi (referência regional — o Bitumirim em Ipiranga não é medido direto). ` +
			`${trechos.join(" · ")}.` +
			(motivo
				? ` Atenção: ${motivo} — acompanhe Defesa Civil/IAT.`
				: " Níveis sem tendência de cheia no momento.") +
			` Para alertas oficiais, siga Defesa Civil e IAT.`,
	};
}

/** Busca as 3 sentinelas ANA em paralelo (usado no cron). */
export async function fetchHidroTriangulacao(
	cemadenAcc6hMax: number | null = null,
): Promise<HidroState> {
	try {
		const resultados = await Promise.all(
			SENTINELAS.map((s) =>
				fetchEstacao(s.codigo, s.nome, s.rio, s.municipio, s.papel),
			),
		);

		// Se todas falharam, degrada sem quebrar o ciclo de clima
		const comDados = resultados.filter((r) => !r.erro);
		const erro =
			comDados.length === 0
				? resultados.map((r) => r.erro).join(" | ") || "falha"
				: null;

		const risco = avaliarRisco(resultados, cemadenAcc6hMax);

		return {
			estacoes: resultados,
			fonte: "ANA Hidro (telemetria)",
			atualizadoEm: Date.now(),
			erro,
			...risco,
		};
	} catch (e: unknown) {
		const msg = e instanceof Error ? e.message : String(e);
		return {
			estacoes: [],
			fonte: "ANA Hidro (telemetria)",
			atualizadoEm: null,
			erro: msg,
			riscoEnxurrada: "ok",
			riscoCheia: "ok",
			resumoRisco: "Dados hidro temporariamente indisponíveis.",
		};
	}
}
