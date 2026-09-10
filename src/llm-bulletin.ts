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
const LLM_TIMEOUT_MS = 25_000;
const LLM_MAX_TOKENS = 400;

export const LLM_CHAIN = [
	"meta/muse-spark-1.3-contributor",
	"minimax/minimax-m3",
	"tencent/hy3",
	"z-ai/glm-5.3-flash",
] as const;

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
		`MODELO ECMWF: ${ctx.ecmwfPct != null ? `${Math.round(ctx.ecmwfPct)}% de chuva` : "indisponível"}` +
			(ctx.ecmwfProx6hMm != null
				? `, ${ctx.ecmwfProx6hMm.toFixed(1)} mm nas próximas 6h`
				: "") +
			(ctx.condition ? `. Condição atual: ${ctx.condition}` : ""),
	);
	if (ctx.hidroWatch)
		linhas.push(
			"RIOS: triangulação ANA em atenção (nível subindo ou chuva convergente)",
		);
	if (ctx.avisosOficiais.length > 0)
		linhas.push(
			`AVISOS OFICIAIS: ${ctx.avisosOficiais.slice(0, 2).join(" | ")}`,
		);

	return `Você é o analista de tempo do Monitor Ipiranga (cidade no Paraná, Brasil). Os dados abaixo são MEDIÇÕES determinísticas — fonte da verdade, nunca os contradiga nem invente outros números.

${linhas.join("\n")}

Escreva o boletim em 3 ou 4 frases curtas (máximo 600 caracteres), em português simples:
1. Se está chovendo em Ipiranga, ABRA com isso (é a informação mais importante).
2. Depois o núcleo mais relevante, sempre com a distância em km.
3. Nunca afirme certeza — use "pode", "se mantiver o curso".
4. Se um núcleo está longe (>200 km), diga que está longe; não trate como iminente.
5. Sem markdown, sem emoji, sem título. Termine com ponto final.`;
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
			}),
			signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
		});
		if (!res.ok) {
			logger.warn("LLM analista: HTTP", { model, status: res.status });
			return null;
		}
		const json = (await res.json()) as {
			choices?: Array<{
				message?: { content?: string };
				finish_reason?: string;
			}>;
			error?: { message?: string };
		};
		if (json.error) {
			logger.warn("LLM analista: erro do provedor", {
				model,
				error: json.error.message,
			});
			return null;
		}
		const text = (json.choices?.[0]?.message?.content ?? "").trim();
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
): Promise<{ text: string; model: string } | null> {
	const apiKey = loadConfig().openRouterApiKey;
	if (!apiKey) {
		logger.warn(
			"LLM analista: sem OPENROUTER_API_KEY, pulando para heurística",
		);
		return null;
	}
	const prompt = buildAnalystPrompt(ctx);
	for (const model of LLM_CHAIN) {
		const text = await chamaOpenRouter(model, prompt, apiKey);
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
		logger.info("LLM analista: boletim aceito", { model, len: text.length });
		return { text, model };
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

	// 1. Reuso do LLM: texto openrouter <30 min E cenário igual.
	try {
		const cached = await getLatestNowcastBulletin();
		if (
			cached &&
			cached.source === "openrouter" &&
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
			source: "openrouter",
			generatedAt: Date.now(),
		};
		try {
			await saveNowcastBulletin(llm.text, "openrouter");
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
