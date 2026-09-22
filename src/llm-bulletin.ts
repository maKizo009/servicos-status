import { loadConfig } from "./config.js";
import {
	getLatestNowcastBulletin,
	saveNowcastBulletin,
	type NowcastBulletinRecord,
} from "./db.js";
import { rotularLocalizacao } from "./geo-municipio.js";
import { logger } from "./logger.js";
import {
	buildHeuristicBulletin,
	type EcmwfContext,
	fraseChuvaLocal,
	type LocalRainContext,
	type NowcastBulletin,
	validateBulletinAgainstVerdict,
} from "./nowcast-vlm.js";
import type { NowcastResult } from "./radar-analysis.js";
import { fmtEta, haversineKm, type ThreatVerdict } from "./radar-analysis.js";

/**
 * Camada B2 — LLM analista (10/09/2026, ideia do Dave).
 *
 * A heurística (template if/else) NÃO reconcilia fontes contraditórias —
 * ela preenche lacunas sem comparar uma frase com a outra (caso real:
 * "chegaria em 2h mas só chegaria em muitas horas" + "sem alerta iminente"
 * enquanto chovia 44 mm). O LLM entra como ANALISTA: recebe todos os
 * números determinísticos (Camada A) e redige 3-4 frases curtas.
 *
 * Cadeia via OpenRouter (OpenAI-compatível puro — funciona do serverless,
 * sem o header x-opencode-session que quebra o opencode-go fora do loop):
 *  1. meta/muse-spark-1.3-contributor (primário do Dave; 404 até ele liberar
 *     o toggle de privacidade no OpenRouter → cai sozinho pro próximo)
 *  2. minimax/minimax-m3 (fallback, validado ao vivo)
 *  3. tencent/hy3 + z-ai/glm-5.3-flash (reservas, validados ao vivo)
 *  4. heurística (sempre disponível, zero rede)
 *
 * Cadência: texto LLM vale 30 min (custo ~US$0,001/boletim); a heurística
 * preenche os intervalos e assume se o provedor falhar. O LLM NUNCA é fonte
 * de número — validação pós-geração com os mesmos gates determinísticos +
 * gate de coerência local (chovendo aqui e o texto não abre com isso? lixo).
 */

export const LLM_TTL_MS = 30 * 60_000;
// 60s: gpt-oss-20b é modelo de raciocínio e a latência é INSTÁVEL (medido com o
// prompt real: 2,9s / 14,6s / 15,6s / 28,6s / 47,5s / >40s). 25s cortava demais.
// O boletim é gerado no CICLO (cron), não na requisição do usuário — o card serve
// do cache — então esperar é aceitável. Estourou o timeout? Cai na heurística.
const LLM_TIMEOUT_MS = 30_000;
// Modelos de raciocínio (minimax-m3 etc.) gastam o budget PENSANDO: com 400
// tokens o finish vinha "length" com content vazio. 2000 dá folga pro
// raciocínio + ~150 tokens de boletim (custo segue irrelevante: ~US$0,0006).
const LLM_MAX_TOKENS = 2000;

// Cadeia do boletim. OpenRouter é o PRINCIPAL — foi o que sempre funcionou aqui.
// Em 21/09/2026 eu li "use no openrouter" como proibição e troquei tudo pra NIM;
// era o contrário (o Dave quis dizer "use o Jev NA OpenRouter"). Revertido.
// NIM fica como RESERVA: verificado vivo no bun (openai/gpt-oss-20b com
// reasoning_effort=low → 5,8-20s), mas a chave de produção não respondeu, então
// não é ele quem carrega o boletim. Heurística determinística fecha a fila.
export const LLM_CHAIN: LlmEntry[] = [
	{ provider: "openrouter", model: "meta/muse-spark-1.3-contributor" },
	{ provider: "openrouter", model: "minimax/minimax-m3" },
	{ provider: "nim", model: "openai/gpt-oss-20b" },
];

interface LlmEntry {
	provider: "openrouter" | "gemini" | "nim";
	model: string;
}

import type { SoloCidade } from "./sigma-feed.js";
import { passaCoerenciaAmeaca } from "./bulletin-coherence.js";

export interface AnalystThreat {
	municipio: string;
	uf: string | null;
	distKm: number;
	intensity: string;
	/**
	 * `nucleo` = tempestade (heavy/extreme); `area` = área de chuva contínua
	 * moderada. O analista precisa saber a diferença: área molha o chão sem
	 * trovoada, e antes ela nem chegava no contexto (caso 21/09/2026: o
	 * boletim dizia "nenhum núcleo por perto" com uma área de chuva a 113 km
	 * com ETA ~69 min).
	 */
	kind: "nucleo" | "area";
	approach: ThreatVerdict["approach"] | null;
	etaMin: number | null;
	speedKmh: number | null;
}

export interface AnalystContext {
	fraseLocal: string | null;
	threats: AnalystThreat[];
	alertLevel: "alert" | "watch" | "monitor" | "none";
	ecmwfPct: number | null;
	ecmwfProx6hMm: number | null;
	condition: string | null;
	hidroWatch: boolean;
	avisosOficiais: string[];
	/**
	 * Solo medido nas cidades do corredor (feed do Sigma) — só vem preenchido
	 * quando há núcleo de chuva perto de uma delas. É o dado que diz SEVERIDADE
	 * (rajada, queda de pressão, acumulado), que a refletividade do radar não diz.
	 */
	solo: SoloCidade[];
}

/** Monta o prompt do analista a partir dos números da Camada A. */
export function buildAnalystPrompt(ctx: AnalystContext): string {
	const linhas: string[] = [];
	linhas.push(
		`CHUVA MEDIDA EM IPIRANGA: ${ctx.fraseLocal ?? "sem chuva medida (pluviômetros zerados)"}`,
	);
	linhas.push(`NÍVEL DA CAMADA A: ${ctx.alertLevel}`);
	const nucleos = ctx.threats.filter((t) => t.kind !== "area");
	const areas = ctx.threats.filter((t) => t.kind === "area");
	// Intensidade/aproximação em PORTUGUÊS: o enum cru vazava pro prompt
	// ("área de chuva moderate", "chuva heavy") e o analista tinha de traduzir
	// sozinho — risco de erro de leitura num dado que É a fonte da verdade.
	const INTENSIDADE_PT: Record<string, string> = {
		light: "fraca",
		moderate: "moderada",
		heavy: "forte",
		extreme: "muito forte (temporal)",
	};
	const APROXIMACAO_PT: Record<string, string> = {
		approaching: "se aproximando",
		receding: "se afastando",
		crossing: "trajetória tangencial (passa de lado)",
	};
	const linhaEntidade = (t: AnalystThreat) => {
		const eta = t.approach === "approaching" ? `, ETA ${fmtEta(t.etaMin)}` : "";
		const nome = t.kind === "area" ? "área de chuva" : "núcleo de chuva";
		const intensidade = INTENSIDADE_PT[t.intensity] ?? t.intensity;
		const movimento = t.approach
			? (APROXIMACAO_PT[t.approach] ?? t.approach)
			: "movimento incerto";
		return `- ${nome} ${intensidade} em ${t.municipio}${t.uf ? `/${t.uf}` : ""}, a ${Math.round(t.distKm)} km, ${movimento}${eta}`;
	};
	if (ctx.threats.length === 0) {
		linhas.push(
			"NÚCLEOS E ÁREAS: nenhuma chuva relevante no radar (nem núcleo forte/extremo nem área de chuva moderada)",
		);
	} else {
		if (nucleos.length === 0) {
			linhas.push("NÚCLEOS (tempestade): nenhum núcleo forte/extremo no radar");
		} else {
			linhas.push("NÚCLEOS (tempestade, já ordenados por perigo):");
			for (const t of nucleos.slice(0, 3)) linhas.push(linhaEntidade(t));
		}
		if (areas.length > 0) {
			linhas.push(
				"ÁREAS DE CHUVA (chuva contínua moderada — molha o chão, não é trovoada; NÃO chame de núcleo/tempestade):",
			);
			for (const t of areas.slice(0, 3)) linhas.push(linhaEntidade(t));
		}
	}
	linhas.push(
		`PREVISÃO (ECMWF — é PREVISÃO, NÃO medição): ${
			ctx.ecmwfPct != null ? `${Math.round(ctx.ecmwfPct)}% de chance de chuva` : "indisponível"
		}` +
			(ctx.ecmwfProx6hMm != null
				? `, ${ctx.ecmwfProx6hMm.toFixed(1)} mm nas próximas 6h`
				: "") +
			(ctx.condition ? `. Condição prevista pelo modelo: ${ctx.condition}` : ""),
	);
	if (ctx.hidroWatch)
		linhas.push(
			"RIOS: triangulação ANA em atenção (nível subindo ou chuva convergente)",
		);
	if (ctx.solo.length > 0) {
		linhas.push(
			"SOLO (medição real em cidade do corredor — vale mais que a cor do radar para severidade):",
		);
		for (const s of ctx.solo.slice(0, 4)) {
			const partes: string[] = [];
			if (s.rajada1hKmh != null)
				partes.push(`rajada ${s.rajada1hKmh.toFixed(0)} km/h na última hora`);
			if (s.rajada24hKmh != null)
				partes.push(`rajada máx 24h ${s.rajada24hKmh.toFixed(0)} km/h`);
			if (s.quedaPressao24Hpa != null)
				partes.push(
					`pressão caiu ${s.quedaPressao24Hpa.toFixed(1)} hPa em 24h`,
				);
			if (s.chuva1hMm != null)
				partes.push(`${s.chuva1hMm.toFixed(1)} mm na última hora`);
			if (s.chuva24hMm != null)
				partes.push(`${s.chuva24hMm.toFixed(1)} mm em 24h`);
			linhas.push(
				`- ${s.cidade} (${s.distanciaKm.toFixed(0)} km, ${s.rede}): ${partes.join(", ") || "sem dado útil"}`,
			);
		}
	}
	if (ctx.avisosOficiais.length > 0)
		linhas.push(
			`AVISOS OFICIAIS: ${ctx.avisosOficiais.slice(0, 2).join(" | ")}`,
		);

	return `Você é o analista de tempo do Monitor Ipiranga (cidade no Paraná, Brasil). Os dados abaixo são MEDIÇÕES determinísticas — fonte da verdade, nunca os contradiga nem invente outros números.

${linhas.join("\n")}

Escreva o boletim em 3 ou 4 frases curtas (máximo 600 caracteres), em português simples:
1. A linha "CHUVA MEDIDA EM IPIRANGA" é a ÚNICA fonte sobre chuva acontecendo. Use o TEMPO VERBAL dela: "chove agora" só quando ela citar mm na última hora; acumulado de 6 h/24 h com a última hora zerada é chuva que JÁ PASSOU — escreva "choveu nas últimas horas", nunca "chove agora". Se ela diz que não há chuva medida, NUNCA escreva que chove (nem "chove fraco", nem "chuva leve agora"). A previsão do ECMWF só pode aparecer como chance ("o modelo indica X% de chance"), jamais como chuva acontecendo — e se não há chuva medida nem núcleo perto (nem área de chuva a ≤200 km), o boletim deve dizer isso com clareza.
2. Se houver chuva medida em Ipiranga, ABRA com isso (é a informação mais importante).
3. Depois a entidade mais relevante (núcleo de tempestade OU área de chuva contínua), sempre com a distância em km — e use o nome certo: "núcleo" só para a linha de NÚCLEOS, "área de chuva" para a linha de ÁREAS.
4. Nunca afirme certeza — use "pode", "se mantiver o curso".
5. Se a entidade está longe (>200 km), diga que está longe; não trate como iminente. PROIBIDO escrever "nenhum núcleo por perto" (ou "nenhuma chuva por perto") se as listas NÚCLEOS ou ÁREAS tiverem QUALQUER entidade a ≤200 km — nesse caso diga onde ela está e quando pode chegar. E nunca fale de núcleo distante omitindo a ÁREA DE CHUVA que está vindo: a chuva que se aproxima DEVE aparecer no boletim.
6. Se houver linha de SOLO, use-a para dizer a SEVERIDADE (rajada forte, pressão caindo, acumulado alto) — ela mede o que o radar não mede.
7. Sem markdown, sem emoji, sem título. Termine com ponto final.
8. NÃO repita os rótulos do bloco de dados ("CHUVA MEDIDA EM IPIRANGA:", "NÚCLEOS:", "ÁREAS DE CHUVA:", "PREVISÃO..."). Escreva o boletim direto, como quem fala com o leitor.`;
}

/** Gate de coerência local: chovendo aqui e o texto não fala disso? Lixo. */
export function passaCoerenciaLocal(
	text: string,
	fraseLocal: string | null,
): boolean {
	if (!fraseLocal) return true;
	return /chove|mm|pluviômetro|garoa|chuva/i.test(text);
}

async function chamaOpenRouter(
	model: string,
	prompt: string,
	apiKey: string,
): Promise<string | null> {
	try {
		const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${apiKey}`,
				"HTTP-Referer": "https://servicos-status.vercel.app",
				"X-Title": "Monitor Ipiranga",
			},
			body: JSON.stringify({
				model,
				messages: [{ role: "user", content: prompt }],
				temperature: 0.3,
				max_tokens: LLM_MAX_TOKENS,
				// Medido 21/09/2026 com o prompt real: sem isso o gpt-oss-20b raciocina
				// por 22-60s+ (estourou o timeout 3x); com reasoning_effort=low vai a
				// 5,8s e o texto segue correto. O gargalo era o raciocínio, não a rede.
				reasoning_effort: "low",
			}),
			signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
		});
		if (!res.ok) {
			logger.warn("LLM analista: HTTP", { model, status: res.status });
			return null;
		}
		const json = (await res.json()) as {
			choices?: Array<{ message?: { content?: string } }>;
			error?: { message?: string };
		};
		if (json.error) {
			logger.warn("LLM analista: erro do provedor", { model, error: json.error.message });
			return null;
		}
		return (json.choices?.[0]?.message?.content ?? "").trim() || null;
	} catch (e) {
		logger.warn("LLM analista: falha", { model, error: String(e) });
		return null;
	}
}

async function chamaNim(
	model: string,
	prompt: string,
	apiKey: string,
	endpoint: string,
): Promise<string | null> {
	try {
		const res = await fetch(endpoint, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${apiKey}`,
			},
			body: JSON.stringify({
				model,
				messages: [{ role: "user", content: prompt }],
				temperature: 0.3,
				max_tokens: LLM_MAX_TOKENS,
				// Medido 21/09/2026 com o prompt real: sem isso o gpt-oss-20b raciocina
				// por 22-60s+ (estourou o timeout 3x); com reasoning_effort=low vai a
				// 5,8s e o texto segue correto. O gargalo era o raciocínio, não a rede.
				reasoning_effort: "low",
			}),
			signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
		});
		if (!res.ok) {
			logger.warn("LLM analista: HTTP", { model, status: res.status });
			return null;
		}
		const json = (await res.json()) as {
			choices?: Array<{ message?: { content?: string } }>;
			error?: { message?: string };
		};
		if (json.error) {
			logger.warn("LLM analista: erro do provedor", { model, error: json.error.message });
			return null;
		}
		return (json.choices?.[0]?.message?.content ?? "").trim() || null;
	} catch (e) {
		logger.warn("LLM analista: falha", { model, error: String(e) });
		return null;
	}
}

async function chamaGemini(
	model: string,
	prompt: string,
	apiKey: string,
): Promise<string | null> {
	try {
		const res = await fetch(
			`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					contents: [{ parts: [{ text: prompt }] }],
					generationConfig: {
						temperature: 0.3,
						maxOutputTokens: LLM_MAX_TOKENS,
					},
				}),
				signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
			},
		);
		if (!res.ok) {
			logger.warn("LLM analista: HTTP", { model, status: res.status });
			return null;
		}
		const json = (await res.json()) as {
			candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
			error?: { message?: string };
		};
		if (json.error) {
			logger.warn("LLM analista: erro do provedor", {
				model,
				error: json.error.message,
			});
			return null;
		}
		const text = (json.candidates?.[0]?.content?.parts ?? [])
			.map((p) => p.text ?? "")
			.join("")
			.trim();
		return text || null;
	} catch (e) {
		logger.warn("LLM analista: falha", { model, error: String(e) });
		return null;
	}
}

/**
 * Tenta gerar o boletim via cadeia LLM (validado). Retorna null se nenhum
 * modelo entregar texto aceitável — o chamador cai na heurística.
 */
export async function tryLlmBulletin(
	ctx: AnalystContext,
	verdict: ThreatVerdict | null,
	ecmwf: EcmwfContext | undefined,
	relevance: {
		alertLevel?: "alert" | "watch" | "monitor" | "none";
		nearestThreatKm?: number | null;
	},
): Promise<{ text: string; model: string; provider: "openrouter" | "gemini" | "nim" } | null> {
	const cfg = loadConfig();
	if (!cfg.openRouterApiKey && !cfg.geminiApiKey && !cfg.nvidiaNimApiKey) {
		logger.warn(
			"LLM analista: sem chave de provedor (OpenRouter/NIM/Gemini), pulando para heurística",
		);
		return null;
	}
	const prompt = buildAnalystPrompt(ctx);
	for (const entry of LLM_CHAIN) {
		const { model, provider } = entry;
		if (provider === "openrouter" && !cfg.openRouterApiKey) continue;
		if (provider === "gemini" && !cfg.geminiApiKey) continue;
		if (provider === "nim" && !cfg.nvidiaNimApiKey) continue;
		const text =
			provider === "openrouter"
				? await chamaOpenRouter(model, prompt, cfg.openRouterApiKey)
				: provider === "gemini"
					? await chamaGemini(model, prompt, cfg.geminiApiKey)
					: await chamaNim(model, prompt, cfg.nvidiaNimApiKey, cfg.nvidiaNimEndpoint);
		if (!text) continue;
		if (text.length > 700) {
			logger.warn("LLM analista: texto prolixo demais, rejeitado", {
				model,
				len: text.length,
			});
			continue;
		}
		// O texto cita uma ETA por entidade (área e núcleo): valide contra TODAS as
		// do contexto. Com um alvo só, boletim correto era reprovado em série e o
		// card caía na heurística (22/09/2026).
		if (
			!validateBulletinAgainstVerdict(text, verdict, ecmwf, {
				...relevance,
				etasValidas: (ctx.threats ?? [])
					.map((t) => t.etaMin ?? 0)
					.filter((n) => n > 0),
			})
		)
			continue;
		if (!passaCoerenciaLocal(text, ctx.fraseLocal)) {
			logger.warn("LLM analista: sem coerência local, rejeitado", {
				model,
				text: text.slice(0, 120),
			});
			continue;
		}
		logger.info("LLM analista: boletim aceito", { model, provider, len: text.length });
		return { text, model, provider };
	}
	return null;
}

export interface SmartBulletinInput {
	nowcast: NowcastResult;
	ecmwf: EcmwfContext;
	relevance: {
		alertLevel: "alert" | "watch" | "monitor" | "none";
		nearestThreatKm: number | null;
	};
	local: LocalRainContext | null;
	fraseLocal: string | null;
	analyst: AnalystContext;
	verdict: ThreatVerdict | null;
}

/**
 * Monta o AnalystContext a partir das peças que o ciclo já tem.
 * Município real via malha IBGE (mesma usada na heurística).
 */
export function buildAnalystContext(
	nowcast: NowcastResult,
	opts: {
		local: LocalRainContext | null;
		condition: string | null;
		ecmwfPct: number | null;
		ecmwfProx6hMm: number | null;
		alertLevel: "alert" | "watch" | "monitor" | "none";
		hidroWatch: boolean;
		avisosOficiais: string[];
		solo?: SoloCidade[];
	},
): {
	analyst: AnalystContext;
	fraseLocal: string | null;
	verdict: ThreatVerdict | null;
} {
	const threats: AnalystThreat[] = nowcast.threats.slice(0, 3).map((t) => {
		const r = rotularLocalizacao(t.lat, t.lon, haversineKm);
		return {
			municipio: r.municipio?.nome ?? r.nome,
			uf: r.municipio?.uf ?? r.uf ?? null,
			distKm: t.distToTargetKm,
			intensity: t.intensity,
			kind: t.kind ?? "nucleo",
			approach: t.threat?.approach ?? null,
			etaMin: t.threat?.etaMin ?? null,
			speedKmh: t.movement?.speedKmh ?? null,
		};
	});
	const fraseLocal = fraseChuvaLocal(opts.local);
	return {
		analyst: {
			fraseLocal,
			threats,
			alertLevel: opts.alertLevel,
			ecmwfPct: opts.ecmwfPct,
			ecmwfProx6hMm: opts.ecmwfProx6hMm,
			condition: opts.condition,
			hidroWatch: opts.hidroWatch,
			avisosOficiais: opts.avisosOficiais,
			solo: opts.solo ?? [],
		},
		fraseLocal,
		verdict: nowcast.threats[0]?.threat ?? null,
	};
}

/**
 * Janela em que o texto é reusado mesmo com o cenário diferente: trava de CUSTO.
 * Fora dela, só reusa se a impressão do cenário bater. Antes o reuso era puramente
 * por tempo (30 min), e como o ciclo regravava o texto reusado com timestamp novo,
 * o cache nunca expirava e o boletim ficava congelado indefinidamente (22/09/2026).
 */
const REUSE_MIN_MS = 12 * 60_000;

/**
 * Impressão do CENÁRIO do boletim: mesmos insumos ⇒ mesma chave; qualquer mudança
 * material (chuva medida, núcleo, previsão, rio, aviso, solo) ⇒ chave nova.
 * É o que permite reusar texto sem servir número velho.
 */
export function chaveDoCenario(a: AnalystContext | null | undefined): string {
	const partes = [
		a?.fraseLocal ?? "sem-chuva",
		String(a?.alertLevel ?? ""),
		String(a?.ecmwfPct ?? ""),
		String(a?.ecmwfProx6hMm ?? ""),
		String(a?.condition ?? ""),
		a?.hidroWatch ? "hidro" : "",
		String(a?.avisosOficiais?.length ?? 0),
		(a?.threats ?? [])
			.map(
				(t) =>
					`${t.kind}:${t.municipio}:${Math.round(t.distKm)}:${t.intensity}:${t.approach ?? "-"}`,
			)
			.join("|"),
		(a?.solo ?? [])
			.map((s) => `${s.cidade}:${s.chuva1hMm ?? "-"}:${s.rajada1hKmh ?? "-"}`)
			.join("|"),
	].join("§");
	let h = 5381;
	for (let i = 0; i < partes.length; i++) {
		h = ((h << 5) + h + partes.charCodeAt(i)) | 0;
	}
	return `${(h >>> 0).toString(36)}-${partes.length.toString(36)}`;
}

function contextoKey(input: SmartBulletinInput): string {
	return chaveDoCenario(input.analyst);
}

/**
 * Decide se o texto em cache ainda pode ser servido. Extraído para ser TESTÁVEL:
 * a versão antiga comparava só tempo + presença de frase, e deixou um boletim de
 * "chove agora" sobreviver com pluviômetro zerado (incidente 22/09/2026).
 */
export function avaliarReuso(i: {
	cached: NowcastBulletinRecord | null;
	local: LocalRainContext | null;
	nowcast: NowcastResult;
	chaveCenario: string;
	agora?: number;
}): { reusar: boolean; motivo: string } {
	const { cached, local, nowcast, chaveCenario } = i;
	const agora = i.agora ?? Date.now();
	if (!cached) return { reusar: false, motivo: "sem boletim em cache" };
	const fonteLlm =
		cached.source === "openrouter" ||
		cached.source === "nvidia_nim" ||
		cached.source === "gemini";
	if (!fonteLlm) return { reusar: false, motivo: "último boletim é heurística" };
	const idadeMs = agora - cached.generatedAt;
	if (idadeMs >= LLM_TTL_MS) return { reusar: false, motivo: "TTL vencido" };
	// "Está chovendo agora" é MEDIÇÃO na ÚLTIMA HORA — acumulado de 6 h/24 h é
	// chuva que já passou (fraseChuvaLocal também fala de acumulado).
	const choveAgoraMedido = (local?.acc1hrMax ?? 0) >= 0.5;
	const textoDizChoveAgora = /chove (em ipiranga )?agora|est[áa] chovendo/i.test(
		cached.text,
	);
	if (choveAgoraMedido !== textoDizChoveAgora) {
		return {
			reusar: false,
			motivo: choveAgoraMedido
				? "começou a chover e o texto não diz"
				: "parou de chover e o texto diz que chove agora",
		};
	}
	// Número citado que a medição de agora desmente (ex.: "13,6 mm na última hora"
	// com pluviômetro zerado).
	const mmTexto = /([\d]+(?:[.,]\d+)?)\s*mm na última hora/i.exec(cached.text);
	const mmTextoNum = mmTexto ? Number(mmTexto[1].replace(",", ".")) : null;
	if (mmTextoNum != null && mmTextoNum >= 0.5 && (local?.acc1hrMax ?? 0) < 0.5) {
		return {
			reusar: false,
			motivo: "texto cita chuva na última hora e o pluviômetro está zerado",
		};
	}
	if (/\d{2,4}\s*km/.test(cached.text) && nowcast.threats.length === 0) {
		return { reusar: false, motivo: "texto cita núcleo e o radar está limpo" };
	}
	if (!cached.text || !passaCoerenciaAmeaca(cached.text, nowcast.threats)) {
		return { reusar: false, motivo: "texto contradiz o radar" };
	}
	// Cenário igual = insumos iguais. Sem isso o texto congelava enquanto o
	// timestamp era renovado a cada ciclo (ver o save redundante no index.ts).
	const cenarioIgual = !cached.contextKey || cached.contextKey === chaveCenario;
	if (cenarioIgual) return { reusar: true, motivo: "mesmo cenário" };
	if (idadeMs < REUSE_MIN_MS) {
		return { reusar: true, motivo: "texto recente (trava de custo)" };
	}
	return { reusar: false, motivo: "cenário mudou" };
}

/**
 * Orquestra boletim inteligente: LLM (30 min) → heurística (sempre).
 * Reutiliza texto LLM se o cenário não mudou (chuva começou/parou, número citado
 * desmentido pela medição, núcleo dissipou → regenera). Persiste o vencedor.
 */
export async function generateSmartBulletin(
	input: SmartBulletinInput,
): Promise<NowcastBulletin> {
	const { nowcast, ecmwf, relevance, local, fraseLocal, analyst, verdict } =
		input;
	const heuristic = () =>
		buildHeuristicBulletin(nowcast, ecmwf, relevance, local);

	// 1. Reuso do LLM: só com o MESMO cenário (impressão do contexto) dentro do TTL.
	const chaveCenario = contextoKey(input);
	try {
		const cached = await getLatestNowcastBulletin();
		const aval = avaliarReuso({ cached, local, nowcast, chaveCenario });
		if (aval.reusar && cached) {
			logger.info("Boletim LLM reutilizado", {
				motivo: aval.motivo,
				idadeMin: Math.round((Date.now() - cached.generatedAt) / 60000),
				fraseLocal: fraseLocal ? "com-chuva" : "sem-chuva",
			});
			return cached;
		}
		if (cached) {
			logger.info("Boletim LLM stale, regenerando", { motivo: aval.motivo });
		}
	} catch (e) {
		logger.warn("LLM: leitura do cache falhou", { error: String(e) });
	}

	// 2. Tenta a cadeia LLM.
	const llm = await tryLlmBulletin(analyst, verdict, ecmwf, relevance);
	if (llm && !passaCoerenciaAmeaca(llm.text, nowcast.threats)) {
		logger.warn(
			"Boletim LLM rejeitado pelo gate de coerência de ameaça — caindo na heurística",
			{ provider: llm.provider, texto: llm.text.slice(0, 160) },
		);
	} else if (llm) {
		const bulletin: NowcastBulletin = {
			text: llm.text,
			source:
				llm.provider === "openrouter"
					? "openrouter"
					: llm.provider === "gemini"
						? "gemini"
						: "nvidia_nim",
			generatedAt: Date.now(),
		};
		try {
			await saveNowcastBulletin(
				llm.text,
				llm.provider === "openrouter"
					? "openrouter"
					: llm.provider === "gemini"
						? "gemini"
						: "nvidia_nim",
				chaveCenario,
			);
		} catch (e) {
			logger.warn("LLM: persistência falhou", { error: String(e) });
		}
		return bulletin;
	}

	// 3. Fallback: heurística (sempre funciona, zero rede).
	const text = heuristic();
	try {
		await saveNowcastBulletin(text, "heuristic", chaveCenario);
	} catch (e) {
		logger.warn("Heurística: persistência falhou", { error: String(e) });
	}
	return { text, source: "heuristic", generatedAt: Date.now() };
}
