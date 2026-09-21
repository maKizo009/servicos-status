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

import { preverCalhaAoVivo } from "./bitumirim-previsao.js";
import type { PrevisaoCalha } from "./bitumirim-previsao.js";

const REQUEST_TIMEOUT_MS = 15_000;

// 3 sentinelas na calha do Tibagi — montante→jusante em relação à foz do
// Bitumirim (-25,0049, -50,4279). CORREÇÃO 11/09/2026 (auditoria Antigravity
// + mapa OSM): a foz fica ~110 km ao SUL da barragem de Mauá (-24,0419),
// fora do reservatório (cauda em -24,2946). Ou seja: Antas (1,1 km a jusante
// da usina) mede água INDO EMBORA de Ipiranga — foi REMOVIDA do ciclo.
// Uvaia (alto Tibagi, Ponta Grossa) é a sentinela de montante de verdade.
export const SENTINELAS = [
	{
		codigo: "64444000",
		nome: "Uvaia",
		rio: "Tibagi",
		papel: "Montante — onda vindo do alto Tibagi em direção à foz",
		municipio: "Ponta Grossa",
	},
	{
		codigo: "64504210",
		nome: "Cebolão",
		rio: "Tibagi",
		papel: "Jusante distante (Londrina, ~180 km da foz) — NÃO prevê Ipiranga; só confirma escoamento dias depois",
		municipio: "Londrina",
	},
	{
		codigo: "64507000",
		nome: "Jataizinho (UHE Capivara)",
		rio: "Tibagi",
		papel: "Jusante distante — NÃO prevê Ipiranga; só confirma escoamento dias depois",
		municipio: "Jataizinho",
	},
] as const;

/**
 * Faixas de referência por sentinela — P90/P98 de 365 DIAS reais
 * (10/09/2025–10/09/2026, ciclo hidrológico completo). CORREÇÃO 11/09/2026:
 * as faixas anteriores (180 dias mar–set) excluíam a estação chuvosa e
 * subestimavam os percentis (auditoria Antigravity). Lixo de sensor
 * (nível 777777.7 = código de falha) sempre filtrado.
 *
 * - 64444000 Uvaia: nível P90 385 / P98 455 (máx ano 513); vazão P98 225
 * - 64504210 Cebolão: nível P90 337 / P98 360 (máx 419); vazão P98 1119
 * - 64507000 Jataizinho: nível P90 263 / P98 301 (máx 404); vazão P98 949
 *   (display/escoamento — fora do cálculo do IBR)
 *
 * São faixas RELATIVAS (percentil), não cotas oficiais de inundação.
 * Recalibrar anualmente (série longa do DadosHidrometeorologicos).
 */
export const FAIXAS: Record<
	string,
	{ atencaoCm: number; alertaCm: number; vazaoP98: number }
> = {
	"64444000": { atencaoCm: 385, alertaCm: 455, vazaoP98: 225 },
	"64504210": { atencaoCm: 337, alertaCm: 360, vazaoP98: 1119 },
	"64507000": { atencaoCm: 263, alertaCm: 301, vazaoP98: 949 },
};

/**
 * Tetos históricos — picos medidos nos 3 eventos de referência:
 * - OUT23 (enchente histórica, fim out/início nov 2023): chuva 323 mm/4d em
 *   São Braz + 257 mm em Suruvi + 90 mm em Castro; Uvaia 1189 cm,
 *   Cebolão 517 cm, Jataizinho 534 cm/3061 m³/s, Bitumirim 8 m em Ipiranga
 *   (4x o normal de ~2 m, ~7 mil atingidos — G1/Defesa Civil 31/10/2023).
 * - DEZ24 (cheia regional, 07-09/12/2024): 149+128 mm em São Braz,
 *   106+99 mm em Suruvi; Uvaia 815 cm, Cebolão 391 cm,
 *   Jataizinho 366 cm/1430 m³/s (pico com ~3-6 dias de atraso da chuva).
 * - JAN25 (flash local, 19/01/2025): 143 mm/dia em São Braz (19 mm em Suruvi
 *   a 11 km — tromba hiper-localizada); Tibagi CALMO (Cebolão 325 cm,
 *   Jataizinho 256 cm, abaixo do P90). Prova: sentinela não vê flash local.
 * Antas (fora do ciclo desde 11/09/2026 — a jusante da foz) mantida só como
 * referência histórica: OUT23 903 cm/2683 m³/s, DEZ24 622/1366.
 */
export const TETOS_HISTORICOS = {
	out23: {
		uvaiaCm: 1189,
		cebolaoCm: 517,
		jataizinhoCm: 534,
		chuvaSpBrazMm: 323,
		bitumirimM: 8,
	},
	dez24: {
		uvaiaCm: 815,
		cebolaoCm: 391,
		jataizinhoCm: 366,
		chuvaSpBrazMm: 298,
		bitumirimM: null,
	},
	jan25: {
		uvaiaCm: null,
		cebolaoCm: 325,
		jataizinhoCm: 256,
		chuvaSpBrazMm: 143,
		bitumirimM: null,
	},
} as const;

/** Nível crítico = teto DEZ24 (cheia regional recente, abaixo da histórica). */
export const NIVEL_CRITICO: Record<string, number> = {
	"64444000": TETOS_HISTORICOS.dez24.uvaiaCm,
	"64504210": TETOS_HISTORICOS.dez24.cebolaoCm,
	"64507000": TETOS_HISTORICOS.dez24.jataizinhoCm,
};

/** Faixa estendida com o estágio crítico (≥ teto DEZ24). */
export function faixaEstendida(
	codigo: string,
	nivelCm: number | null,
): "normal" | "atencao" | "alerta" | "critico" | null {
	if (nivelCm == null) return null;
	const crit = NIVEL_CRITICO[codigo];
	if (crit != null && nivelCm >= crit) return "critico";
	return faixaNivel(codigo, nivelCm);
}

export type NivelIBR = "verde" | "amarelo" | "laranja" | "vermelho";

export interface ResultadoPermanencia {
	/** Dias estimados fora da caixa SE transbordar no nível atual. */
	diasEstimados: number;
	nivel: NivelIBR;
	uvaiaCm: number | null;
	/** n=2 (OUT23+DEZ24) — preliminar até mais rótulos. Sempre true por ora. */
	preliminar: boolean;
	motivos: string[];
}

/**
 * Permanência (v3, 11/09/2026) — substitui o IBR (aposentado: v1 usava Antas
 * a jusante; v2 usava Cebolão em Londrina como "calha na foz").
 * Rótulos reais (fotos Dave + Uvaia horária ANA):
 * - OUT23: Uvaia pico 1189 → 7 dias fora (29/10 18h → 05/11)
 * - DEZ24: Uvaia pico 815 → 3 dias fora (09/12 13h → 12/12)
 * - JAN25: Uvaia 180 → 0 dias (régua 4m sem sair da caixa)
 * Ajuste 2 pontos: dias = 0,0107 × U − 5,7 (≥0, passo 0,5). PRELIMINAR.
 * Lógica: chuva local causa o transbordo (perna flash/IFL); Uvaia manda em
 * quanto tempo a água leva pra descer (onda que vem atrás segura a foz).
 * Uso ao vivo: aplica o ajuste no Uvaia atual; se subindo ≥50 cm/24h, +1 dia
 * (pico à frente). É estimativa condicional, não medição — diz "SE
 * transbordar, fica ~X dias", nunca "vai transbordar".
 */
export function calcularPermanencia(input: {
	uvaiaCm: number | null;
	deltaUvaia24h: number | null;
}): ResultadoPermanencia {
	const motivos: string[] = [];
	const u = input.uvaiaCm;
	let dias = 0;
	if (u != null) {
		dias = Math.max(0, Math.round((0.0107 * u - 5.7) * 2) / 2);
		motivos.push(
			`Uvaia ${(u / 100).toFixed(2).replace(".", ",")} m (ajuste preliminar n=2: OUT23 7d, DEZ24 3d)`,
		);
	}
	if (
		u != null &&
		input.deltaUvaia24h != null &&
		input.deltaUvaia24h >= 50
	) {
		dias = Math.round((dias + 1) * 2) / 2;
		motivos.push(
			`subindo ${Math.round(input.deltaUvaia24h)} cm/24h — pico à frente, pode estender`,
		);
	}
	const nivel: NivelIBR =
		dias > 5
			? "vermelho"
			: dias > 2
				? "laranja"
				: dias > 0
					? "amarelo"
					: "verde";
	return { diasEstimados: dias, nivel, uvaiaCm: u ?? null, preliminar: true, motivos };
}
export interface ResultadoIFL {
	score: number;
	nivel: NivelIBR;
	motivos: string[];
}

/**
 * Índice de Flash Local (IFL v3.1) — a perna do gatilho (auditoria
 * Antigravity). JAN25 provou que tromba local transborda o Bitumirim com o
 * Tibagi calmo: nenhum índice de remanso pega isso. IFL é chuva local
 * (CEMADEN 1h/6h/24h) + ANTECEDENTE 72h (palco) + REGIME sazonal.
 * - Piso de 0,75 com 24h ≥ 90 mm = assinatura JAN25 (143 mm/dia).
 * - Curto-circuito 1,0 com 1h ≥ 40 mm = chuva que não espera janela fechar.
 * - Antecedente (v3.1): 72h ≥ 150 mm (convectivo) ou ≥ 100 mm (frontal —
 *   inverno arma o palco com pouca água: JUL24 102 mm/mês → 21/31d saturado)
 *   eleva ao piso 0,35 (amarelo): palco armado, mas sem gatilho não há flash.
 *   JAN25-replay (p24 ~15, p72 ~158) → amarelo com rio em 4 m descendo: ok.
 * - Frontal não cria laranja/vermelho sozinho — esses exigem chuva atual.
 */
export function calcularIFL(input: {
	p1h: number | null;
	p6h: number | null;
	p24h: number | null;
	p72h?: number | null;
	regime?: RegimeHidro;
}): ResultadoIFL {
	const motivos: string[] = [];
	const regime: RegimeHidro = input.regime ?? "convectivo";
	const p1 = input.p1h ?? 0;
	const p6 = input.p6h ?? 0;
	const p24 = input.p24h ?? 0;
	const p72 = input.p72h ?? 0;
	let score = 0.5 * Math.min(p1 / 35, 1) + 0.5 * Math.min(p6 / 70, 1);
	if (p1 >= 1 || p6 >= 1 || p24 >= 1) {
		motivos.push(
			`${p1.toFixed(1).replace(".", ",")} mm/1h · ${p6.toFixed(1).replace(".", ",")} mm/6h · ${p24.toFixed(1).replace(".", ",")} mm/24h em Ipiranga`,
		);
	}
	if (p24 >= 90) {
		score = Math.max(score, 0.75);
		motivos.push(
			`acumulado de ${p24.toFixed(0).replace(".", ",")} mm/24h — assinatura de flash tipo JAN25`,
		);
	}
	if (p1 >= 40) {
		score = 1.0;
		motivos.push(
			`chuva extrema agora (${p1.toFixed(1).replace(".", ",")} mm/1h) — enxurrada imediata`,
		);
	}
	const barraAntecedente = regime === "frontal" ? 100 : 150;
	if (p72 >= barraAntecedente) {
		score = Math.max(score, 0.35);
		motivos.push(
			`antecedente ${p72.toFixed(0).replace(".", ",")} mm/72h em Ipiranga (regime ${regime}, barra ${barraAntecedente}) — solo encharcado, palco armado`,
		);
	}
	score = Math.round(score * 100) / 100;
	const nivel: NivelIBR =
		score >= 0.8
			? "vermelho"
			: score >= 0.5
				? "laranja"
				: score >= 0.3
					? "amarelo"
					: "verde";
	return { score, nivel, motivos };
}

/** Regime hidro sazonal (v3.1, 11/09/2026) — doutrina sazonal calibrada em
 * 11 rótulos (3 verão convectivo + 5 inverno frontal + OUT23/JAN25/2011):
 * - Convectivo (set–abr): célula hiper-local → só chuva local manda (JAN25:
 *   Uvaia em P50 com régua em 4 m). IFL puro.
 * - Frontal (mai–ago): frente fria ampla → Uvaia integra a bacia e carrega a
 *   severidade (ranking Dave 13>14≈15>19>17 reproduzido pelo pico Uvaia
 *   1033/995/986/921/659, NÃO pela pilha local). Palco arma com pouca água
 *   (JUL24: 102 mm/mês → solo saturado 21/31d; radiação 8,7 vs 17–20 no verão).
 * Confirmação contínua: radiação média 30d São Braz < 12 MJ/m²/dia bateu nos
 * 6 invernos e em nenhum verão (SMA 2056, offline). Ao vivo usa só o mês
 * (determinístico, zero fetch novo); rad fica como checagem de bancada. */
export type RegimeHidro = "frontal" | "convectivo";

export function regimeDoMes(mes1a12: number): RegimeHidro {
	return mes1a12 >= 5 && mes1a12 <= 8 ? "frontal" : "convectivo";
}

// ============ Projeção Bitumirim (v1.0, 11/09/2026) ============
//
// Modelo calibrado em 2 eventos com dados reais + observação do Dave:
// - OUT23: Bitumirim saiu da calha 29/10 ~16h (Uvaia 756 cm),
//   subindo 4-5 cm/h medido na manhã do 30, estabilizou 31/dia,
//   começou a BAIXAR 01/11 (Uvaia 1132 cm). Recedência lenta (7+ dias).
// - DEZ24: Pico Bitumirim 11/dez (Uvaia 568 cm), BR liberada
//   12/dez manhã (Uvaia 692 cm). Recedência rápida (~2 dias).
// - JAN25: Flash local 143 mm em São Braz, Bitumirim NÃO saiu da calha.
//
// DEFASAGEM Uvaia → Bitumirim:
//   - Bitumirim sai da calha: Uvaia ~700 cm + chuva > 50mm/dia
//   - Pico Bitumirim: 0-2 dias após Uvaia atingir pico
//   - Início da baixa: quando Uvaia começa a estabilizar/descer
//   - Recedência: 2-3d (solo drenado) a 7+dias (solo saturado)

/** Faixas de risco Bitumirim — calibradas em OUT23 e DEZ24 */
export const BITUMIRIM_LIMIARES = {
	saidaCalhaUvaiaCm: 700,
	saidaCalhaChuvaMm: 50,
	riscoSemSaidaUvaiaCm: 550,
	riscoSemSaidaChuvaMm: 100,
	taxaExplosivaCmd: 100,
	taxaModeradaCmd: 30,
} as const;

export interface ProjecaoBitumirim {
	nivelEstimadoM: number | null;
	saiuDaCalha: boolean;
	horasAteCalha: number | null;
	horasAtePico: number | null;
	horasRecedencia: number | null;
	classificacao: "normal" | "atencao" | "alerta" | "critico";
	texto: string;
}

/**
 * Projeta comportamento do Bitumirim com base no Uvaia e chuva local.
 * Modelo empírico calibrado em OUT23 (7 dias fora) e DEZ24 (2 dias fora).
 * Sempre retorna resultado — nunca lança exceção.
 */
export function projetarBitumirim(
	uvaiaCm: number | null,
	taxaSubidaCmd24h: number | null,
	chuvaLocalMm24h: number,
): ProjecaoBitumirim {
	const L = BITUMIRIM_LIMIARES;
	const texto: string[] = [];
	if (uvaiaCm == null) {
		return {
			nivelEstimadoM: null, saiuDaCalha: false, horasAteCalha: null,
			horasAtePico: null, horasRecedencia: null, classificacao: "normal",
			texto: "Uvaia sem dados — projeção indisponível.",
		};
	}
	const taxa = taxaSubidaCmd24h ?? 0;
	const riscoSaida =
		uvaiaCm >= L.saidaCalhaUvaiaCm && chuvaLocalMm24h >= L.saidaCalhaChuvaMm;
	const riscoSemSaida =
		uvaiaCm >= L.riscoSemSaidaUvaiaCm && chuvaLocalMm24h >= L.riscoSemSaidaChuvaMm;
	// Estimativa linear do nível do Bitumirim (m):
	// OUT23: Uvaia 756 cm → ~2.5 m; Uvaia 1189 cm → 8 m
	let nivelEstimadoM: number | null =
		uvaiaCm > 400 ? Math.max(2, Math.min(8, (uvaiaCm - 400) / 120)) : null;
	// Horas até sair da calha
	let horasAteCalha: number | null = null;
	if (!riscoSaida && uvaiaCm < L.saidaCalhaUvaiaCm && taxa > L.taxaModeradaCmd) {
		horasAteCalha = Math.round(((L.saidaCalhaUvaiaCm - uvaiaCm) / taxa) * 24);
	} else if (riscoSaida) {
		horasAteCalha = 0;
	}
	// Horas até pico
	let horasAtePico: number | null = null;
	if (riscoSaida || riscoSemSaida) {
		horasAtePico = taxa > L.taxaExplosivaCmd ? 24 : 48;
	} else if (taxa > L.taxaModeradaCmd) {
		horasAtePico = 72;
	}
	// Horas de recedência
	let horasRecedencia: number | null = null;
	if (riscoSaida || (nivelEstimadoM != null && nivelEstimadoM > 3)) {
		// Solo saturado (chuva > 80mm) = OUT23 (7+ dias); drenado = DEZ24 (2 dias)
		horasRecedencia = chuvaLocalMm24h > 80 ? 168 : 48;
	}
	// Classificação
	let classificacao: ProjecaoBitumirim["classificacao"] = "normal";
	if (nivelEstimadoM != null && nivelEstimadoM >= 6) classificacao = "critico";
	else if (riscoSaida) classificacao = "alerta";
	else if (riscoSemSaida || (nivelEstimadoM != null && nivelEstimadoM >= 4 && taxa > 0))
		classificacao = "atencao";
	// Texto
	if (riscoSaida) {
		texto.push(
			`Bitumirim estimado ${nivelEstimadoM?.toFixed(1) ?? "?"} m — provável transbordamento ` +
				`(Uvaia ${(uvaiaCm / 100).toFixed(2).replace(".", ",")} m + ${chuvaLocalMm24h.toFixed(0)} mm local)`,
		);
		if (horasAtePico != null) texto.push(`Pico estimado em ~${horasAtePico}h`);
		if (horasRecedencia != null)
			texto.push(
				`Recedência: ~${Math.round(horasRecedencia / 24)} dias` +
					(chuvaLocalMm24h > 80 ? " (solo saturado)" : ""),
			);
	} else if (riscoSemSaida) {
		texto.push(
			`Risco de transbordamento: Uvaia ${(uvaiaCm / 100).toFixed(2).replace(".", ",")} m + ${chuvaLocalMm24h.toFixed(0)} mm local`,
		);
	} else if (taxa > L.taxaExplosivaCmd) {
		texto.push(
			`Uvaia subindo ${taxa.toFixed(0)} cm/dia — cheia em 1-3 dias se chuva persistir`,
		);
	} else if (taxa > L.taxaModeradaCmd) {
		texto.push(`Uvaia subindo ${taxa.toFixed(0)} cm/dia — monitorar`);
	}
	return {
		nivelEstimadoM,
		saiuDaCalha: riscoSaida,
		horasAteCalha,
		horasAtePico,
		horasRecedencia,
		classificacao,
		texto:
			texto.join(". ") ||
			"Bitumirim dentro da calha, sem risco de cheia.",
	};
}

/** Mês atual em America/Sao_Paulo (sem lib de data — só Intl). */
export function mesAtualSPagora(): number {
	return Number(
		new Intl.DateTimeFormat("pt-BR", {
			timeZone: "America/Sao_Paulo",
			month: "numeric",
		}).format(new Date()),
	);
}
/** Posição do nível atual contra as faixas. */
export function faixaNivel(
	codigo: string,
	nivelCm: number | null,
): "normal" | "atencao" | "alerta" | null {
	if (nivelCm == null) return null;
	const f = FAIXAS[codigo];
	if (!f) return null;
	if (nivelCm >= f.alertaCm) return "alerta";
	if (nivelCm >= f.atencaoCm) return "atencao";
	return "normal";
}

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
	/** Faixa calibrada do nível atual (P90/P98 de 180 dias) */
	faixa: "normal" | "atencao" | "alerta" | "critico" | null;
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
	/** Permanência (v3) — dias fora da caixa SE transbordar (ajuste n=2) */
	/** @deprecated 21/09/2026 — insumo (Uvaia) não separa transbordo; ver previsao. */
	/** IFL (Índice de Flash Local) — chuva local + antecedente + regime */
	ifl: ResultadoIFL | null;
	/** Regime sazonal vigente na avaliação (v3.1) */
	regime: RegimeHidro | null;
	/** Projeção Bitumirim (v1.0) — nível estimado, tempo até cheia/recedência */
	/** @deprecated 21/09/2026 — nível em metros pelo Uvaia não tem lastro; ver previsao. */
	/** Previsão de saída da calha: vai sair? quando? com que confiança (v1) */
	previsao: PrevisaoCalha | null;
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
				faixa: null,
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
				faixa: null,
				serie: [],
				delta6hCm: null,
				erro: "Sem dados no período",
			};
		}
		const serie = parseXmlDados(xml);
		// Saneia lixo de sensor: 777777.7 = código de falha da telemetria
		// (visto em 250 pontos de 180 dias em Antas). Ponto absurdo não pode
		// virar "leitura atual" nem contaminar o Δ6h.
		const sanea = (p: HidroSeriePonto): HidroSeriePonto => ({
			...p,
			nivelCm:
				p.nivelCm != null && p.nivelCm > 0 && p.nivelCm < 2000
					? p.nivelCm
					: null,
			vazaoM3s:
				p.vazaoM3s != null && p.vazaoM3s >= 0 && p.vazaoM3s < 20000
					? p.vazaoM3s
					: null,
		});
		const serieLimpa = serie.map(sanea);
		if (serieLimpa.length === 0) {
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
				faixa: null,
				serie: [],
				delta6hCm: null,
				erro: "Série vazia",
			};
		}
		let latestIdx = serieLimpa.findIndex((p) => p.nivelCm != null);
		if (latestIdx < 0) latestIdx = 0;
		const latest = serieLimpa[latestIdx];
		// Δ 6 h: compara com o ponto ~6 posições atrás do mais recente válido
		let delta6hCm: number | null = null;
		if (latest.nivelCm != null) {
			let idx = latestIdx + 6;
			while (idx < serieLimpa.length && serieLimpa[idx].nivelCm == null) idx++;
			if (idx < serieLimpa.length && serieLimpa[idx].nivelCm != null) {
				delta6hCm = latest.nivelCm - (serieLimpa[idx].nivelCm as number);
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
			faixa: faixaEstendida(codigo, latest.nivelCm),
			serie: serieLimpa.slice(0, 24),
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
			faixa: null,
			serie: [],
			delta6hCm: null,
			erro: msg,
		};
	}
}

/** Chuva local (CEMADEN, máx entre as estações) para o IFL e o remanso.
 * p72h = antecedente (acc72h máx) — o "palco" da v3.1. */
export interface ChuvaLocal {
	p1h: number | null;
	p6h: number | null;
	p24h: number | null;
	p72h?: number | null;
}

/** Exportada para testes (lógica de faixas/flash/permanência/regime). */
export function avaliarRisco(
	estacoes: HidroEstacao[],
	chuva: ChuvaLocal | null,
	mesOverride?: number,
): Pick<
	HidroState,
	"riscoEnxurrada" | "riscoCheia" | "resumoRisco" | "ifl" | "regime"
> {
	// Triangulação é referência regional (Ipiranga NÃO tem estação
	// fluviométrica própria — o Bitumirim não é medido direto). Por isso a
	// classificação automática é CONSERVADORA: só sobe para "watch" com
	// evidência convergente (rio subindo + chuva medida aqui e na sentinela).
	// "critical" nunca é gerado aqui — cheia se confirma pela Defesa Civil/IAT.
	const comDados = estacoes.filter((e) => !e.erro && e.nivelCm != null);
	const regime: RegimeHidro = regimeDoMes(mesOverride ?? mesAtualSPagora());
	if (comDados.length === 0) {
		return {
			riscoEnxurrada: "ok",
			riscoCheia: "ok",
			ifl: null,
			regime,
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
		const fx = faixaNivel(e.codigo, e.nivelCm);
		const fxTxt =
			fx === "alerta"
				? " (faixa ALERTA)"
				: fx === "atencao"
					? " (faixa atenção)"
					: "";
		const chuva =
			e.chuvaMm != null
				? `, chuva ${e.chuvaMm.toFixed(1).replace(".", ",")} mm/h no local`
				: "";
		return `${nomeCurto}: ${((e.nivelCm as number) / 100).toFixed(2).replace(".", ",")} m${fxTxt} (${fmtDelta(e.delta6hCm)}${chuva})`;
	});
	const subindoForte = comDados.some((e) => (e.delta6hCm ?? 0) >= 30);
	const chuvaSentinela = Math.max(0, ...comDados.map((e) => e.chuvaMm ?? 0));
	const chuvaLocal = chuva?.p6h ?? 0;
	const porCodigo = (cod: string) => comDados.find((e) => e.codigo === cod);
	const uvaia = porCodigo("64444000");
	const faixaUvaia = faixaNivel("64444000", uvaia?.nivelCm ?? null);
	const algumaEmAlerta = comDados.some(
		(e) => faixaNivel(e.codigo, e.nivelCm) === "alerta",
	);
	// DRENAGEM BLOQUEADA (v3): Uvaia alto + chuva em Ipiranga = o que
	// transbordar não desce (OUT23 7d fora, DEZ24 3d). Condicional: só importa
	// se o flash atuar; sozinha não prevê transbordo (DEZ24 transbordou com
	// Uvaia em 339).
	const drenagemBloqueada =
		(faixaUvaia === "atencao" || faixaUvaia === "alerta") &&
		chuvaLocal >= 10;
	// Watch: faixa de alerta, subida forte, drenagem bloqueada ou convergência.
	const watch =
		algumaEmAlerta ||
		subindoForte ||
		drenagemBloqueada ||
		(chuvaLocal >= 15 && chuvaSentinela >= 10);
	const motivos: string[] = [];
	if (algumaEmAlerta)
		motivos.push("nível na faixa de alerta (P98 do ano hidrológico)");
	if (subindoForte)
		motivos.push("nível subindo ≥30 cm em 6h em ao menos uma sentinela");
	if (drenagemBloqueada)
		motivos.push(
			`Uvaia cheia (${uvaia?.nivelCm != null ? (uvaia.nivelCm / 100).toFixed(2).replace(".", ",") : "?"} m) + ${chuvaLocal.toFixed(1).replace(".", ",")} mm/6h em Ipiranga: se transbordar, a água demora pra descer — atenção a áreas baixas`,
		);
	if (chuvaLocal >= 15 && chuvaSentinela >= 10)
		motivos.push(
			`chuva convergente (${chuvaLocal.toFixed(1).replace(".", ",")} mm/6h em Ipiranga + ${chuvaSentinela.toFixed(1).replace(".", ",")} mm/h na sentinela)`,
		);
	// PERMANÊNCIA (v3) + IFL (flash, 100% local) — doutrina 2 pernas:
	// chuva local causa o transbordo (horas); Uvaia manda nos dias fora.
	// delta24h da série horária da própria sentinela (último − primeiro).
	const serieU = (uvaia?.serie ?? []).filter(
		(p): p is { nivelCm: number } & typeof p => p.nivelCm != null,
	);
	const deltaUvaia24h =
		serieU.length >= 2
			? serieU[serieU.length - 1].nivelCm - serieU[0].nivelCm
			: (uvaia?.delta6hCm ?? null);
	// APOSENTADOS (21/09/2026): `permanencia` e a `projecao` v1.0 saíram do estado.
	// O estudo v3.1 mostrou que o Uvaia — insumo dos dois — NÃO separa transbordo de
	// não-transbordo (INV2015 986 cm × JAN25 168 cm, desfechos trocados), então ambos
	// emitiam número com cara de medição sem lastro, e a permanência ainda acendia o
	// "nível dos rios em atenção" do alerta. Quem responde agora é `previsao`
	// ("vai sair da calha?" com confiança) em bitumirim-previsao.ts.
	// As funções seguem no arquivo para consulta/histórico — não são mais chamadas.
	const ifl = calcularIFL({
		p1h: chuva?.p1h ?? null,
		p6h: chuva?.p6h ?? null,
		p24h: chuva?.p24h ?? null,
		p72h: chuva?.p72h ?? null,
		regime,
	});
	if (ifl.nivel !== "verde") {
		motivos.push(`flash local IFL ${ifl.score.toFixed(2).replace(".", ",")} (${ifl.nivel}): ${ifl.motivos.join("; ")}`);
	}
	const watchFinal =
		watch || ifl.nivel === "laranja" || ifl.nivel === "vermelho";
	return {
		riscoEnxurrada: watchFinal ? "warn" : "ok",
		riscoCheia: watchFinal ? "watch" : "ok",
		ifl,
		regime,
		resumoRisco:
			`Triangulação no Rio Tibagi (referência regional — o Bitumirim em Ipiranga não é medido direto; faixas P90/P98 do ano hidrológico). ` +
			`Regime ${regime} (v3.1: mai–ago frontal, Uvaia carrega severidade; set–abr convectivo, só local manda). ` +
			`${trechos.join(" · ")}.` +
			` Flash IFL ${ifl.score.toFixed(2).replace(".", ",")} (${ifl.nivel}).` +
			(motivos.length > 0
				? ` Atenção: ${motivos.join("; ")} — acompanhe Defesa Civil/IAT.`
				: " Níveis sem tendência de cheia no momento.") +
			` Para alertas oficiais, siga Defesa Civil e IAT.`,
	};
}

/** Busca as 3 sentinelas ANA em paralelo (usado no cron). */
export async function fetchHidroTriangulacao(
	chuva: ChuvaLocal | null = null,
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

		const risco = avaliarRisco(resultados, chuva);

		// Previsão de saída da calha — chuva local da SMA ABC (duas estações) +
		// regime + Uvaia. Degrada para null se a ABC não responder (nunca quebra
		// o ciclo e nunca inventa número).
		const uvaia = resultados.find((r) => r.codigo === "64444000");
		const previsao = await preverCalhaAoVivo({
			regime: risco.regime ?? "convectivo",
			uvaiaCm: uvaia?.nivelCm ?? null,
			chuvaAgora: chuva ? { p1h: chuva.p1h, p6h: chuva.p6h } : null,
		});

		return {
			estacoes: resultados,
			fonte: "ANA Hidro (telemetria)",
			atualizadoEm: Date.now(),
			erro,
			...risco,
			previsao,
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
			ifl: null,
			regime: null,
			previsao: null,
			resumoRisco: "Dados hidro temporariamente indisponíveis.",
		};
	}
}
