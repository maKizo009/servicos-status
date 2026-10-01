import { logger } from "./logger.js";

/**
 * Alertas oficiais + alerta unificado próprio do Monitor Ipiranga.
 *
 * Fontes oficiais tentadas (todas com timeout curto, nunca lançam):
 *  - INMET alertas2 (https://alertas2.inmet.gov.br) — avisos com área por
 *    município (filtramos Ipiranga/PR, IBGE 4110508).
 *  - Defesa Civil PR (galeria de avisos SIMEPAR).
 *  - SIMEPAR prognozweb (previsão por município).
 *
 * Como essas fontes vivem atrás de Cloudflare/captcha e podem falhar do
 * serverless, o ALERTA UNIFICADO nunca depende delas: ele é calculado de
 * forma determinística a partir dos NOSSOS dados (CEMADEN + ECMWF + radar
 * + hidro) e usa os oficiais como AGRAVANTE (sobe o nível, nunca desce
 * sozinho sem dado local — exceto aviso vermelho oficial, que sobe por
 * segurança).
 */

export type NivelAlerta = "verde" | "amarelo" | "laranja" | "vermelho";

export interface AvisoOficial {
	fonte: "INMET" | "SIMEPAR" | "Defesa Civil PR";
	titulo: string;
	nivel: NivelAlerta;
	areas?: string;
	inicio?: string;
	fim?: string;
	link?: string;
	/** Confirmado pelo CAP (campo `Municipios`) que Ipiranga/PR é afetado. */
	cobreIpiranga?: boolean;
}

export interface AlertasOficiaisState {
	avisos: AvisoOficial[];
	erros: string[];
	atualizadoEm: number | null;
}

export interface AlertaUnificado {
	nivel: NivelAlerta;
	titulo: string;
	descricao: string;
	/** O que pesou na decisão (observável, sem caixa-preta) */
	motivos: string[];
	avisosOficiais: AvisoOficial[];
	atualizadoEm: number;
}

const FETCH_TIMEOUT_MS = 8_000;
const COD_IBGE_IPIRANGA = "4110508";

async function fetchText(url: string): Promise<string | null> {
	try {
		const res = await fetch(url, {
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
			headers: {
				"User-Agent":
					"ServicosIpirangaStatus/1.0 (+https://servicos-status.vercel.app)",
				Accept: "text/html,application/json",
			},
		});
		if (!res.ok) return null;
		return await res.text();
	} catch {
		return null;
	}
}

function nivelCorInmet(cor: string): NivelAlerta {
	const c = cor.toLowerCase();
	if (c.includes("vermelh") || c.includes("red") || c.includes("grande perigo"))
		return "vermelho";
	if (c.includes("laranja") || c.includes("orange") || c.includes("perigo"))
		return "laranja";
	if (c.includes("amarelo") || c.includes("yellow") || c.includes("potencial"))
		return "amarelo";
	return "verde";
}

/**
 * Regiões de previsão do INMET no Paraná — usadas só como FILTRO GROSSO
 * (o RSS é da América do Sul inteira). A confirmação de que Ipiranga é
 * afetado vem do CAP XML (`/avisos/rss/<id>`, campo `Municipios`), que
 * lista o código IBGE de cada município — NÃO se adivinha geografia aqui
 * (caso 01/10/2026: tratei Ipiranga como "Norte Pioneiro" e estava errado;
 * a mesorregião IPARDES não o inclui). Região aqui só reduz o número de
 * CAPs que precisamos baixar.
 */
const REGIOES_PR = [
	"Norte Pioneiro Paranaense",
	"Centro Ocidental Paranaense",
	"Centro Oriental Paranaense",
	"Centro-Sul Paranaense",
	"Metropolitana de Curitiba",
	"Noroeste Paranaense",
	"Norte Central Paranaense",
	"Oeste Paranaense",
	"Sudeste Paranaense",
	"Sudoeste Paranaense",
	"Campos Gerais",
];

/** Quantos CAPs baixar para confirmar Ipiranga por ciclo (custo de rede). */
const MAX_CAPS_POR_CICLO = 8;

/**
 * Converte a "Severidade" do INMET em nível do monitor.
 *
 * Escala INMET (do mais grave pro menos):
 *   "Perigo Extremo" / "Emergência" → vermelho
 *   "Perigo"                        → laranja
 *   "Perigo Potencial" / "Atenção"  → amarelo
 * Cuidado: "Perigo Potencial" contém "Perigo" — testar o grau MAIS específico
 * primeiro, senão tudo vira laranja (bug de primeira versão, 01/10/2026).
 */
function nivelSeveridadeInmet(txt: string): NivelAlerta {
	const s = txt.toLowerCase();
	if (s.includes("extremo") || s.includes("emerg")) return "vermelho";
	if (s.includes("potencial")) return "amarelo";
	if (s.includes("perigo")) return "laranja";
	if (s.includes("aten")) return "amarelo";
	return "verde";
}

/** INMET via RSS oficial (apiprevmet3) — filtra avisos que cobrem o PR. */
async function fetchInmet(): Promise<{
	avisos: AvisoOficial[];
	erro?: string;
}> {
	const url = "https://apiprevmet3.inmet.gov.br/avisos/rss";
	const txt = await fetchText(url);
	if (!txt || txt.length < 200) {
		return { avisos: [], erro: "INMET RSS indisponível (timeout/bloqueio)" };
	}
	try {
		const itens = txt.split("<item>").slice(1);
		const avisos: AvisoOficial[] = [];
		let capsBaixados = 0;
		for (const bruto of itens) {
			const item = bruto.split("</item>")[0] ?? "";
			const desc = /<description><!\[CDATA\[([\s\S]*?)\]\]>/.exec(item)?.[1] ?? "";
			const titulo = /<title>([\s\S]*?)<\/title>/.exec(item)?.[1]?.trim() ?? "";
			const link = /<link>([\s\S]*?)<\/link>/.exec(item)?.[1]?.trim();
			if (!desc && !titulo) continue;
			const limpo = desc
				.replace(/<[^>]+>/g, " ")
				.replace(/\s+/g, " ")
				.trim();
			// Área: as regiões do INMET são nomes de região de previsão.
			// Só entra se alguma região do PR aparecer — o feed é da América
			// do Sul inteira e o resto não interessa ao monitor.
			const areas = /(?:Área|Ãrea)\s*(.*?)\s*$/i.exec(limpo)?.[1] ?? limpo;
			const citouPR = REGIOES_PR.some((r) =>
				limpo.toLowerCase().includes(r.toLowerCase()),
			);
			if (!citouPR) continue;
			// Campos da tabela: Status / Evento / Severidade / Início / Fim
			const campo = (nome: string) =>
				new RegExp(
					`${nome}\\s+(\\S[^|]{0,120}?)(?=\\s+[A-ZÁÉÍÓÚÃÕÇ][a-záéíóúãõç]+\\s+|$)`,
					"i",
				).exec(limpo)?.[1]?.trim();
			const evento = campo("Evento") ?? titulo.replace(/^Aviso de\s+/i, "");
			// O TÍTULO traz "Severidade Grau: <grau>" — mais confiável que o
			// regex do campo, que cortava "Perigo Potencial" em "Perigo".
			const grauDoTitulo =
				/severidade\s+grau:\s*([^.,;]+)/i.exec(titulo)?.[1] ?? titulo;
			avisos.push({
				fonte: "INMET",
				titulo: (titulo || `Aviso INMET: ${evento}`).slice(0, 200),
				nivel: nivelSeveridadeInmet(`${grauDoTitulo} ${titulo}`),
				areas: areas.slice(0, 240),
				inicio: campo("Início") ?? campo("Inicio"),
				fim: campo("Fim"),
				link: link ?? "https://avisos.inmet.gov.br/",
			});
			// Confirmação por IBGE no CAP: o aviso só marca Ipiranga se o
			// município (4110508) aparece na lista `Municipios` do CAP.
			// Sem isso, "aviso no PR" virava "aviso em Ipiranga" — mentira.
			const capId = /\/avisos\/rss\/(\d+)/.exec(link ?? "")?.[1];
			if (capId && capsBaixados < MAX_CAPS_POR_CICLO) {
				capsBaixados++;
				const cap = await fetchText(
					`https://apiprevmet3.inmet.gov.br/avisos/rss/${capId}`,
				);
				const cobre =
					!!cap &&
					(new RegExp(`Ipiranga\\s*-\\s*PR\\s*\\(${COD_IBGE_IPIRANGA}\\)`).test(cap) ||
						cap.includes(COD_IBGE_IPIRANGA));
				const u = avisos[avisos.length - 1];
				if (u) {
					u.cobreIpiranga = cobre;
					if (cobre && !u.titulo.includes("Ipiranga")) {
						u.titulo = `${u.titulo} — atinge Ipiranga`.slice(0, 200);
					}
				}
			}
		}
		return { avisos };
	} catch {
		return { avisos: [], erro: "INMET RSS ilegível (parse falhou)" };
	}
}

/** Defesa Civil PR: extrai menções de aviso meteorológico vigente da página. */
async function fetchDefesaCivil(): Promise<{
	avisos: AvisoOficial[];
	erro?: string;
}> {
	const txt = await fetchText(
		"https://www.defesacivil.pr.gov.br/Galeria-de-Imagens/Aviso-meteorologico-SIMEPAR",
	);
	if (!txt) return { avisos: [], erro: "Defesa Civil PR indisponível" };
	// Procura blocos de aviso com data recente no HTML (sem parser pesado).
	const achados: AvisoOficial[] = [];
	const re =
		/aviso[^<]{0,200}(temporal|chuva|vendaval|granizo|geada|enchente|alagamento|deslizamento)[^<]{0,200}/gi;
	let m: RegExpExecArray | null;
	for (;;) {
		m = re.exec(txt);
		if (!m || achados.length >= 3) break;
		const titulo = m[0]
			.replace(/<[^>]+>/g, "")
			.replace(/\s+/g, " ")
			.trim()
			.slice(0, 200);
		if (titulo.length > 20) {
			achados.push({
				fonte: "Defesa Civil PR",
				titulo,
				nivel: /temporal|vendaval|granizo|enchente/i.test(titulo)
					? "laranja"
					: "amarelo",
				link: "https://www.defesacivil.pr.gov.br/Galeria-de-Imagens/Aviso-meteorologico-SIMEPAR",
			});
		}
	}
	return { avisos: achados };
}

/** Busca as fontes oficiais em paralelo (usado no cron). Nunca lança. */
export async function fetchAlertasOficiais(): Promise<AlertasOficiaisState> {
	try {
		const [inmet, dc] = await Promise.all([fetchInmet(), fetchDefesaCivil()]);
		const avisos = [...inmet.avisos, ...dc.avisos];
		const erros: string[] = [];
		if (inmet.erro) erros.push(inmet.erro);
		if (dc.erro) erros.push(dc.erro);
		return { avisos, erros, atualizadoEm: Date.now() };
	} catch (e) {
		return {
			avisos: [],
			erros: [e instanceof Error ? e.message : String(e)],
			atualizadoEm: null,
		};
	}
}

export interface DadosLocaisAlerta {
	acc1hrMax: number | null;
	acc6hrMax: number | null;
	acc24hrMax: number | null;
	/** true = nenhuma estação CEMADEN fresca: acumulado é "sem dado", não "sem chuva". */
	pluviometroSemDado?: boolean;
	ecmwfPct: number | null;
	ecmwfProx6hMm: number | null;
	radarAlertLevel: "alert" | "watch" | "monitor" | "none";
	/**
	 * Núcleo de tempestade (heavy/extreme) na zona de alerta — é o que PODE
	 * interromper o celular. Área de chuva moderada NÃO entra aqui.
	 *
	 * IMPORTANTE (29/09/2026): aqui chega a evidência já CONFIRMADA pela série de
	 * ciclos (`avaliarPersistencia`). Núcleo severo que apareceu num único ciclo
	 * NÃO promove laranja — ele entra em `radarSeveroNaoConfirmado`.
	 */
	radarSevero?: boolean;
	/** Núcleo severo no 1º ciclo (sem confirmação no ciclo anterior): fica no amarelo */
	radarSeveroNaoConfirmado?: boolean;
	/** Quantos ciclos seguidos sustentam a evidência severa (transparência no card) */
	radarSeveroCiclos?: number;
	/** Entidade que dirigiu o alerta, p/ o texto não chamar área de "chuva forte". */
	radarKind?: "nucleo" | "area" | null;
	hidroWatch: boolean;
}

/**
 * Nosso próprio alerta: fusão determinística dos dados locais + oficiais.
 * Oficiais AGRAVAM (sobem o nível); só o vermelho oficial sobe sozinho.
 */
/** Contexto de TRANSIÇÃO entre ciclos (maleabilidade do tom). */
export interface ContextoTransicaoAlerta {
	/** Nível do ciclo anterior — permite narrar rebaixamento/subida */
	nivelAnterior?: NivelAlerta | null;
	/** O núcleo que dirigia o alerta está enfraquecendo no radar */
	nucleoDissipando?: boolean;
}


/**
 * Traduz a descrição técnica do alerta em texto pro público geral.
 *
 * A `descricao` original serve pro card (que tem "detalhes atrás de botão")
 * e pra auditoria — mas a NOTIFICAÇÃO push vai pra gente comum no celular,
 * onde "núcleo severo confirmado em 2 ciclos seguidos de radar (10 min cada)"
 * não significa nada e ainda assusta mais do que a situação real.
 *
 * Regra do dono (01/10/2026): "núcleo de chuva forte" ≠ "núcleo severo".
 * O primeiro é o que o radar vê (heavy/extreme); o segundo é o nome do nosso
 * interno pra evidência que dispara push. Pro usuário, um só: chuva forte.
 */
export function descricaoParaPessoas(
	a: Pick<AlertaUnificado, "nivel" | "titulo"> & {
		motivos?: string[];
		descricao?: string;
	},
): string {
	const oQueTem: Record<string, string> = {
		vermelho:
			"Chuva muito forte na região — risco de alagamento e queda de energia.",
		laranja: "Chuva forte se aproximando da região.",
		amarelo: "Possibilidade de chuva na região.",
		verde: "Tempo calmo por aqui.",
	};
	const partes = [oQueTem[a.nivel] ?? oQueTem.verde];
	const mudou = /Alerta (subiu|rebaixado)/.exec(a.descricao ?? "")?.[0];
	if (mudou) {
		partes.push(
			mudou.includes("subiu")
				? "A situação piorou desde a última checagem."
				: "A situação melhorou desde a última checagem.",
		);
	}
	// Só alerta quem precisa agir: verde/amarelo não pedem olhar o radar.
	if (a.nivel === "laranja" || a.nivel === "vermelho") {
		partes.push("Acompanhe o radar do app — as condições podem mudar rápido.");
	}
	return partes.join(" ");
}

export function buildAlertaUnificado(
	local: DadosLocaisAlerta,
	oficiais: AlertasOficiaisState | null,
	transicao: ContextoTransicaoAlerta = {},
): AlertaUnificado {
	const motivos: string[] = [];
	let nivel: NivelAlerta = "verde";

	const c1 = local.acc1hrMax ?? 0;
	const c6 = local.acc6hrMax ?? 0;
	const c24 = local.acc24hrMax ?? 0;
	const pct = local.ecmwfPct ?? 0;

	// --- Base: o que está MEDIDO aqui ---
	// Pluviômetro local parado NÃO é "sem chuva": sem leitura fresca, os
	// acumulados valem null (sem dado) e o motivo aparece explícito — nunca
	// silencioso. Nível continua vindo do radar/ECMWF, mas o operador sabe.
	if (local.pluviometroSemDado) {
		motivos.push(
			"pluviômetro local sem leitura fresca (CEMADEN) — chuva medida indisponível",
		);
	}
	if (c1 >= 20 || c6 >= 50) {
		nivel = "vermelho";
		motivos.push(
			`chuva forte medida em Ipiranga (${c1.toFixed(1).replace(".", ",")} mm/1h, ${c6.toFixed(1).replace(".", ",")} mm/6h)`,
		);
	} else if (c6 >= 25 || c24 >= 50 || local.radarSevero) {
		// Laranja = interrompe o celular. Exige SEVERIDADE: chuva medida acima do
		// limiar OU núcleo de tempestade na zona de alerta. Área de chuva moderada
		// NÃO promove a laranja (regra do dono 21/09/2026) — ela fica no amarelo,
		// e o título não pode afirmar "chuva forte" para uma área.
		nivel = "laranja";
		if (local.radarSevero) {
			motivos.push("chuva forte detectada no radar, se aproximando da região");
			const ciclos = local.radarSeveroCiclos ?? 0;
			// "Núcleo severo" é termo INTERNO (o que dispara push). No texto do
			// usuário é só "chuva forte confirmada" — separar evita alarmismo
			// (pedido do dono 01/10/2026: "núcleo de chuva forte ≠ núcleo severo").
			if (ciclos >= 2)
				motivos.push(
					`chuva forte confirmada no radar há ${ciclos} checagens seguidas`,
				);
		}
		if (c6 >= 25)
			motivos.push(
				`${c6.toFixed(1).replace(".", ",")} mm em 6h nos pluviômetros`,
			);
		if (c24 >= 50)
			motivos.push(
				`${c24.toFixed(1).replace(".", ",")} mm em 24h nos pluviômetros`,
			);
	} else if (
		local.radarAlertLevel === "alert" ||
		local.radarAlertLevel === "watch" ||
		c24 >= 20 ||
		c6 >= 10 ||
		pct >= 70 ||
		(local.ecmwfProx6hMm ?? 0) >= 5 ||
		local.hidroWatch
	) {
		nivel = "amarelo";
		if (local.radarAlertLevel === "alert" || local.radarAlertLevel === "watch")
			motivos.push(
				local.radarSeveroNaoConfirmado === true
					? "chuva forte apareceu no radar — vamos confirmar nos próximos minutos antes de alertar"
					: local.radarKind === "area"
						? "área de chuva se aproximando (sem tempestade)"
						: "chuva em vigilância no radar",
			);
		if (c24 >= 20)
			motivos.push(
				`${c24.toFixed(1).replace(".", ",")} mm em 24h nos pluviômetros`,
			);
		if (pct >= 70)
			motivos.push(
				`ECMWF indica ${Math.round(pct)}% de chance de chuva (previsão — não é medição)`,
			);
		if ((local.ecmwfProx6hMm ?? 0) >= 5)
			motivos.push(
				`previsão de ${(local.ecmwfProx6hMm as number).toFixed(1).replace(".", ",")} mm nas próximas 6h (modelo, não medição)`,
			);
		if (local.hidroWatch)
			motivos.push("nível dos rios em atenção (triangulação ANA)");
	}

	// --- Agravante oficial ---
	// REGRA (01/10/2026, falso positivo apontado pelo dono): só um aviso que
	// (a) esteja VIGENTE e (b) tenha Ipiranga CONFIRMADO na lista de municípios
	// do CAP pode subir o nível. Antes o reduce pegava o nível máximo de
	// QUALQUER aviso — um laranja pra "Centro Ocidental Paranaense" (longe de
	// Ipiranga) subia o alerta da cidade pra laranja com radar limpo. Aviso de
	// região vizinha NÃO é aviso de Ipiranga.
	const agoraMs = Date.now();
	const todosAvisos = oficiais?.avisos ?? [];
	const vigentes = todosAvisos.filter((a) => {
		if (!a.fim) return true; // sem data de fim: assume vigente
		const fim = Date.parse(a.fim.replace(" ", "T"));
		return !Number.isFinite(fim) || fim > agoraMs;
	});
	const avisosIpiranga = vigentes.filter((a) => a.cobreIpiranga === true);
	// Vermelho oficial sobe mesmo sem confirmação de município: é grave demais
	// pra ignorar (segurança acima de precisão). Os demais exigem confirmação.
	const vermelhoSemConfirmar = vigentes.filter(
		(a) => a.nivel === "vermelho" && a.cobreIpiranga !== false,
	);
	const maxOficial: NivelAlerta = [
		...avisosIpiranga,
		...vermelhoSemConfirmar,
	].reduce<NivelAlerta>(
		(acc, a) => (ordem(a.nivel) > ordem(acc) ? a.nivel : acc),
		"verde",
	);
	const fonteOficial =
		[...avisosIpiranga, ...vermelhoSemConfirmar][0]?.fonte ?? "INMET";
	if (maxOficial === "vermelho") {
		if (nivel !== "vermelho")
			motivos.push("aviso VERMELHO oficial (INMET/Defesa Civil) para a região");
		nivel = "vermelho";
	} else if (ordem(maxOficial) > ordem(nivel) && nivel !== "verde") {
		motivos.push(
			`aviso ${maxOficial} oficial (${fonteOficial}) atingindo Ipiranga`,
		);
		nivel = maxOficial;
	} else if (maxOficial !== "verde" && nivel === "verde") {
		// Oficial sozinho (sem chuva local) vira amarelo de atenção, não pânico.
		motivos.push(
			`aviso ${maxOficial} oficial (${fonteOficial}) atingindo Ipiranga — sem chuva medida aqui no momento`,
		);
		nivel = "amarelo";
	}

	// O título só pode AFIRMAR chuva em Ipiranga se houver MEDIÇÃO (pluviômetro
	// fresco ou núcleo de radar perto). Previsão do ECMWF sozinha vira "previsão
	// de chuva", nunca "chuva". Bug ao vivo 21/09/2026: o alerta dizia "chuva em
	// Ipiranga/região" com o CEMADEN zerado e nenhum núcleo no radar.
	const medidoChuva =
		c1 >= 0.5 ||
		c6 >= 5 ||
		c24 >= 10 ||
		local.radarAlertLevel === "alert" ||
		local.radarAlertLevel === "watch";
	const soPrevisao = nivel !== "verde" && !medidoChuva;
	// Chuva ainda NÃO caiu aqui: o radar vê a entidade chegando (sem pluviômetro).
	// Título diz "se aproximando", nunca "chuva em Ipiranga" (que o leitor lê como
	// chuva caindo agora).
	const soRadar = medidoChuva && !(c1 >= 0.5 || c6 >= 5 || c24 >= 10);
	const titulo =
		nivel === "vermelho"
			? "Alerta vermelho — risco alto de chuva forte em Ipiranga"
			: nivel === "laranja"
				? soRadar
					? "Alerta laranja — chuva forte se aproximando de Ipiranga/região"
					: "Alerta laranja — chuva forte em Ipiranga/região"
				: nivel === "amarelo"
					? soPrevisao
						? "Atenção — previsão de chuva para Ipiranga/região (nada medido ainda)"
						: soRadar
							? "Atenção — chuva se aproximando de Ipiranga/região"
							: "Atenção — chuva em Ipiranga/região"
					: "Tempo sem alertas em Ipiranga";

	// Maleabilidade do tom (pedido do dono 27/09/2026): quando o alerta DESCE, a
	// descrição diz que desceu e por quê — não fica com tom antigo de tempestade
	// depois que o núcleo enfraqueceu/dissipou no radar. O `nivel` já reflete o
	// ciclo atual (não há trava): isto é a narração da mudança, não a decisão.
	const anterior = transicao.nivelAnterior ?? null;
	const desceu = anterior != null && ordem(nivel) < ordem(anterior);
	const subiu = anterior != null && ordem(nivel) > ordem(anterior);
	const mudanca = desceu
		? ` Alerta rebaixado de ${anterior} para ${nivel}${transicao.nucleoDissipando ? " — o núcleo está enfraquecendo no radar" : ""}.`
		: subiu
			? ` Alerta subiu de ${anterior} para ${nivel}.`
			: "";

	const descricao =
		motivos.length > 0
			? `${titulo}. Motivos: ${motivos.join("; ")}.${mudanca}`
			: `${desceu ? titulo : "Sem chuva relevante medida nem avisos oficiais para Ipiranga no momento."}${mudanca}`;

	return {
		nivel,
		titulo,
		descricao,
		motivos,
		avisosOficiais: todosAvisos,
		atualizadoEm: Date.now(),
	};
}

function ordem(n: NivelAlerta): number {
	return n === "verde" ? 0 : n === "amarelo" ? 1 : n === "laranja" ? 2 : 3;
}

export function logAlertaUnificado(a: AlertaUnificado): void {
	logger.info("Alerta unificado calculado", {
		nivel: a.nivel,
		motivos: a.motivos,
		avisos: a.avisosOficiais.length,
	});
}
