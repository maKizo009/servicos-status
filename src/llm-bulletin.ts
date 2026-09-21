import { loadConfig } from "./config.js";
import { getLatestNowcastBulletin, saveNowcastBulletin } from "./db.js";
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

export interface AnalystThreat {
	municipio: string;
	uf: string | null;
	distKm: number;
	intensity: string;
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
		`CHUVA EM IPIRANGA AGORA: ${ctx.fraseLocal ?? "sem chuva medida (pluviômetros zerados)"}`,
	);
	linhas.push(`NÍVEL DA CAMADA A: ${ctx.alertLevel}`);
	if (ctx.threats.length === 0) {
		linhas.push("NÚCLEOS: nenhum núcleo forte/extremo no radar");
	} else {
		linhas.push("NÚCLEOS (top 3, já ordenados por perigo):");
		for (const t of ctx.threats.slice(0, 3)) {
			const eta =
				t.approach === "approaching" ? `, ETA ${fmtEta(t.etaMin)}` : "";
			linhas.push(
				`- chuva ${t.intensity} em ${t.municipio}${t.uf ? `/${t.uf}` : ""}, a ${Math.round(t.distKm)} km, ${t.approach ?? "movimento incerto"}${eta}`,
			);
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
1. A linha "CHUVA EM IPIRANGA AGORA" é a ÚNICA fonte sobre chuva acontecendo: se ela diz que não há chuva medida, NUNCA escreva que chove (nem "chove fraco", nem "chuva leve agora"). A previsão do ECMWF só pode aparecer como chance ("o modelo indica X% de chance"), jamais como chuva acontecendo — e se não há chuva medida nem núcleo perto, o boletim deve dizer isso com clareza.
2. Se houver chuva medida em Ipiranga, ABRA com isso (é a informação mais importante).
2. Depois o núcleo mais relevante, sempre com a distância em km.
3. Nunca afirme certeza — use "pode", "se mantiver o curso".
4. Se um núcleo está longe (>200 km), diga que está longe; não trate como iminente.
5. Se houver linha de SOLO, use-a para dizer a SEVERIDADE (rajada forte, pressão caindo, acumulado alto) — ela mede o que o radar não mede.
6. Sem markdown, sem emoji, sem título. Termine com ponto final.
7. NÃO repita os rótulos do bloco de dados ("CHUVA EM IPIRANGA AGORA:", "NÚCLEOS:", "PREVISÃO..."). Escreva o boletim direto, como quem fala com o leitor.`;
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
		if (!validateBulletinAgainstVerdict(text, verdict, ecmwf, relevance))
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
 * Orquestra boletim inteligente: LLM (30 min) → heurística (sempre).
 * Reutiliza texto LLM <30 min se o cenário não mudou (chuva começou/parou
 * ou núcleo dissipou → regenera). Persiste o vencedor para o cache.
 */
export async function generateSmartBulletin(
	input: SmartBulletinInput,
): Promise<NowcastBulletin> {
	const { nowcast, ecmwf, relevance, local, fraseLocal, analyst, verdict } =
		input;
	const heuristic = () =>
		buildHeuristicBulletin(nowcast, ecmwf, relevance, local);

	// 1. Reuso do LLM: texto gemini <30 min E cenário igual.
	try {
		const cached = await getLatestNowcastBulletin();
		if (
			cached &&
			// Reusa boletim de qualquer fonte de LLM da cadeia atual (não da heurística).
			(cached.source === "openrouter" ||
				cached.source === "nvidia_nim" ||
				cached.source === "gemini") &&
			Date.now() - cached.generatedAt < LLM_TTL_MS
		) {
			const choviaAntes = /chove em ipiranga|chuva forte já acumulada/i.test(
				cached.text,
			);
			const choveAgora = fraseLocal != null;
			const temDist = /\d{2,4}\s*km/.test(cached.text);
			const vazioAgora = nowcast.threats.length === 0;
			if (
				choviaAntes === choveAgora &&
				!(temDist && vazioAgora) &&
				cached.text.length > 0
			) {
				logger.info("Boletim LLM reutilizado (<30 min, cenário igual)");
				return cached;
			}
			logger.info("Boletim LLM stale (cenário mudou), regenerando");
		}
	} catch (e) {
		logger.warn("LLM: leitura do cache falhou", { error: String(e) });
	}

	// 2. Tenta a cadeia LLM.
	const llm = await tryLlmBulletin(analyst, verdict, ecmwf, relevance);
	if (llm) {
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
			);
		} catch (e) {
			logger.warn("LLM: persistência falhou", { error: String(e) });
		}
		return bulletin;
	}

	// 3. Fallback: heurística (sempre funciona, zero rede).
	const text = heuristic();
	try {
		await saveNowcastBulletin(text, "heuristic");
	} catch (e) {
		logger.warn("Heurística: persistência falhou", { error: String(e) });
	}
	return { text, source: "heuristic", generatedAt: Date.now() };
}
