import { PNG } from "pngjs";
import { type AppConfig, loadConfig } from "./config.js";
import { rotularLocalizacao } from "./geo-municipio.js";
import { logger } from "./logger.js";
import type { NowcastResult } from "./radar-analysis.js";
import {
	assessThreat,
	fetchTileGrid,
	haversineKm,
	type NormalizedRegion,
	normalizeRegion,
	projectCell,
	type RegionSpec,
	type ThreatVerdict,
} from "./radar-analysis.js";

/**
 * Camada B — Análise não-determinística (VLM Gemini 3.6 Flash Lite).
 *
 * Recebe os números da Camada A (nowcast determinístico) + o composite
 * visual dos frames de radar ANOTADO (pin de Ipiranga, números nos núcleos,
 * labels de tempo) e pede ao VLM um boletim narrativo em português:
 * cor dos núcleos, direção de deslocamento e se há chuva vindo para Ipiranga.
 *
 * O LLM NUNCA é a fonte dos números (isso é a Camada A); ele interpreta
 * e redige a partir dos dados + imagem. Fallback: NVIDIA NIM (legado) e
 * depois heurística se o VLM falhar ou não houver chave configurada.
 */

const FRAMES_IN_COMPOSITE = 3;

/** Alvo do nowcast (mesmo valor histórico de nowcast-service.ts). */
const TARGET_IPIRANGA = { lat: -25.0244, lon: -50.5847 } as const;

/** Modelo VLM padrão (Google Gemini Flash Lite — visão + baixo custo).
 * Obs.: "gemini-3.6-flash" validado em 2026-08-13 (chave nova do Dave AQ.Ab8...);
 * a antiga "gemini-flash-lite-latest" respondia 200 mas com a chave antiga o
 * fallback Gemini morria (401/400). Lista: /v1beta/models. */
const GEMINI_VLM_MODEL = "gemini-3.6-flash";

/**
 * Contexto da previsão numérica ECMWF (Open-Meteo) — fonte de médio prazo,
 * concatenada com o nowcast para a decisão probabilística do VLM.
 */
export interface EcmwfContext {
	rainProbabilityPct: number;
	hourlyForecast: {
		time: string;
		tempC: number;
		rainProbabilityPct: number;
		precipitationMm: number;
	}[];
}

export interface NowcastBulletin {
	text: string;
	source: "opencode_vision" | "gemini" | "nvidia_nim_vision" | "heuristic";
	generatedAt: number;
}

/**
 * Chama o VLM Gemini (API generativelanguage.googleapis.com) com imagem
 * inline base64. Retorna o texto ou null em falha/resposta vazia.
 */
async function callGeminiVision(
	apiKey: string,
	model: string,
	prompt: string,
	dataUrl: string,
): Promise<string | null> {
	const base64 = dataUrl.replace(/^data:image\/png;base64,/, "");
	const res = await fetch(
		`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				contents: [
					{
						role: "user",
						parts: [
							{ text: prompt },
							{
								inline_data: {
									mime_type: "image/png",
									data: base64,
								},
							},
						],
					},
				],
				generationConfig: { maxOutputTokens: 300, temperature: 0.4 },
			}),
			signal: AbortSignal.timeout(25_000),
		},
	);
	if (!res.ok) {
		logger.warn("Camada B: Gemini HTTP", { model, status: res.status });
		return null;
	}
	const json = (await res.json()) as {
		candidates?: Array<{
			content?: { parts?: Array<{ text?: string }> };
		}>;
	};
	const text = json.candidates?.[0]?.content?.parts
		?.map((p) => p.text ?? "")
		.join("")
		.trim();
	return text || null;
}

/** Chama o VLM legado da NVIDIA NIM (fallback quando não há chave Gemini). */
async function callNimVision(
	config: AppConfig,
	apiKey: string,
	model: string,
	prompt: string,
	dataUrl: string,
): Promise<string | null> {
	const res = await fetch(config.nvidiaNimEndpoint, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${apiKey}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			model,
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: prompt },
						{ type: "image_url", image_url: { url: dataUrl } },
					],
				},
			],
			// reasoning_effort REMOVIDO (achado 2026-08-12): com o composite
			// real do radar (1536x512) + prompt completo, o reasoning low do
			// minimax-m3 estoura o timeout de 90s (testado: 108s na cadeia) e
			// pode retornar content vazio. Sem reasoning: ~1s de resposta.
			// Se quiser re-tentar reasoning, reduzir o composite (COMPOSITE_MAX_PX)
			// e/ou aumentar o timeout ANTES — não apenas religar o campo.
			max_tokens: 350,
			temperature: 0.4,
		}),
		signal: AbortSignal.timeout(25_000),
	});
	if (!res.ok) {
		logger.warn("Camada B: NIM vision HTTP", { model, status: res.status });
		return null;
	}
	const json = (await res.json()) as {
		choices?: Array<{ message?: { content?: string } }>;
	};
	return json.choices?.[0]?.message?.content?.trim() || null;
	}

/**
 * Chama o VLM principal via OpenCode Go (API OpenAI-compatível) — default
 * minimax-m3 (visão + custo baixo). O MiniMax raciocina antes de responder
 * (bloco <think>...</think>); o bloco é removido para não vazar no boletim.
 */
async function callOpenCodeVision(
	config: AppConfig,
	prompt: string,
	dataUrl: string,
): Promise<string | null> {
	const res = await fetch("https://opencode.ai/zen/go/v1/chat/completions", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${config.openCodeApiKey}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			model: config.openCodeVlmModel,
			// thinking desabilitado: o MiniMax M3 raciocina antes de responder
			// (bloco <think>) — desligar corta tokens de saída (custo) e
			// latência; o strip abaixo fica como defesa em profundidade.
			thinking: { type: "disabled" },
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: prompt },
						{ type: "image_url", image_url: { url: dataUrl } },
					],
				},
			],
			max_tokens: 350,
			temperature: 0.4,
		}),
		signal: AbortSignal.timeout(25_000),
	});
	if (!res.ok) {
		logger.warn("Camada B: OpenCode vision HTTP", {
			model: config.openCodeVlmModel,
			status: res.status,
		});
		return null;
	}
	const json = (await res.json()) as {
		choices?: Array<{ message?: { content?: string } }>;
	};
	let text = json.choices?.[0]?.message?.content?.trim() || null;
	if (text) {
		// remove bloco de raciocínio (MiniMax M3 pensa antes de responder)
		text = text.replace(/^[\s\S]*?<\/think>\s*/i, "").trim();
	}
	return text || null;
}

/**
 * Monta um composite PNG dos frames de radar da região (mosaico reduzido).
 * Cada frame vira uma "coluna" do composite; mosaicos grandes (grid z=9)
 * são reduzidos para no máximo COMPOSITE_MAX_PX por lado (nearest-neighbor)
 * para não explodir o payload do VLM.
 */
const COMPOSITE_MAX_PX = 512;

// ============ Anotações no composite (grounding visual) ============
// O VLM precisa VER onde fica Ipiranga e quais núcleos o sistema associou
// aos dados. Sem isso ele narra qualquer núcleo do frame como se fosse
// sobre Ipiranga (incidente 2026-08-12: "núcleo se aproximando" a 336 km).
// Desenhamos: pin + label "IPIRANGA" em cada frame, labels de tempo
// (T-20m / T-10m / AGORA) e círculos numerados nos top-N núcleos do
// último frame — a legenda dos números vai no prompt.

/** Fonte bitmap 5x7 (linhas de 5 chars, '#' = pixel aceso). Só os chars usados. */
const FONT5x7: Record<string, string[]> = {
	A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
	B: ["11110", "10001", "10001", "11110", "10001", "10001", "11110"],
	C: ["01110", "10001", "10000", "10000", "10000", "10001", "01110"],
	D: ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
	E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
	G: ["01110", "10001", "10000", "10111", "10001", "10001", "01111"],
	H: ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
	I: ["11111", "00100", "00100", "00100", "00100", "00100", "11111"],
	K: ["10001", "10010", "10100", "11000", "10100", "10010", "10001"],
	L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
	M: ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
	N: ["10001", "11001", "10101", "10011", "10001", "10001", "10001"],
	O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
	P: ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
	R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
	S: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
	T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
	U: ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
	V: ["10001", "10001", "10001", "10001", "10001", "01010", "00100"],
	Z: ["11111", "00001", "00010", "00100", "01000", "10000", "11111"],
	"0": ["01110", "10011", "10101", "11001", "10001", "10001", "01110"],
	"1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
	"2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
	"3": ["11111", "00010", "00100", "00010", "00001", "10001", "01110"],
	"4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
	"5": ["11111", "10000", "11110", "00001", "00001", "10001", "01110"],
	"6": ["00110", "01000", "10000", "11110", "10001", "10001", "01110"],
	"7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
	"8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
	"9": ["01110", "10001", "10001", "01111", "00001", "00010", "01100"],
	m: ["00000", "00000", "11010", "10101", "10101", "10101", "10101"],
	h: ["10000", "10000", "10110", "11001", "10001", "10001", "10001"],
	"-": ["00000", "00000", "00000", "11111", "00000", "00000", "00000"],
	" ": ["00000", "00000", "00000", "00000", "00000", "00000", "00000"],
};

/** Escreve um pixel RGBA no buffer PNG (com bounds check). */
function setPx(
	buf: Buffer,
	width: number,
	height: number,
	x: number,
	y: number,
	[r, g, b]: readonly [number, number, number],
): void {
	if (x < 0 || y < 0 || x >= width || y >= height) return;
	const i = (y * width + x) * 4;
	buf[i] = r;
	buf[i + 1] = g;
	buf[i + 2] = b;
	buf[i + 3] = 255;
}

/** Desenha texto 5x7 na posição (x,y) = canto superior esquerdo. */
function drawText(
	buf: Buffer,
	width: number,
	height: number,
	x: number,
	y: number,
	text: string,
	color: readonly [number, number, number],
): void {
	let cx = x;
	for (const ch of text.toUpperCase()) {
		const glyph = FONT5x7[ch] ?? FONT5x7[" "];
		for (let row = 0; row < 7; row++) {
			for (let col = 0; col < 5; col++) {
				if (glyph[row][col] === "1") {
					setPx(buf, width, height, cx + col, y + row, color);
				}
			}
		}
		cx += 6; // 5 px + 1 de espaçamento
	}
}

/** Texto com contorno escuro (legível sobre qualquer cor de fundo). */
function drawTextOutlined(
	buf: Buffer,
	width: number,
	height: number,
	x: number,
	y: number,
	text: string,
	color: readonly [number, number, number],
): void {
	const dark: readonly [number, number, number] = [0, 0, 0];
	for (const [dx, dy] of [
		[-1, -1],
		[1, -1],
		[-1, 1],
		[1, 1],
	] as const) {
		drawText(buf, width, height, x + dx, y + dy, text, dark);
	}
	drawText(buf, width, height, x, y, text, color);
}

/** Círculo preenchido (r = raio em px). */
function drawCircle(
	buf: Buffer,
	width: number,
	height: number,
	cx: number,
	cy: number,
	r: number,
	color: readonly [number, number, number],
): void {
	for (let dy = -r; dy <= r; dy++) {
		for (let dx = -r; dx <= r; dx++) {
			if (dx * dx + dy * dy <= r * r) {
				setPx(buf, width, height, cx + dx, cy + dy, color);
			}
		}
	}
}

/** Converte lat/lon → pixel (x,y) DENTRO de um frame do composite reduzido. */
function latLonToFramePx(
	lat: number,
	lon: number,
	norm: NormalizedRegion,
	frameW: number,
	frameH: number,
): { x: number; y: number } {
	const n = 2 ** norm.grid.z;
	const xf = ((lon + 180) / 360) * n;
	const latRad = (lat * Math.PI) / 180;
	const yf =
		((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
	const tileX = Math.floor(xf);
	const tileY = Math.floor(yf);
	const px = (xf - tileX) * 256;
	const py = (yf - tileY) * 256;
	const mx = (tileX - norm.grid.xMin) * 256 + px;
	const my = (tileY - norm.grid.yMin) * 256 + py;
	const fx = frameW / norm.width;
	const fy = frameH / norm.height;
	return { x: Math.round(mx * fx), y: Math.round(my * fy) };
}

export async function buildRadarComposite(
	host: string,
	pastFrames: { time: number; path: string }[],
	region: RegionSpec,
	opts?: {
		/** Núcleos do último frame (para numerar os top-N no composite) */
		latestCells?: { lat: number; lon: number; intensity: string }[];
		/** Alvo (pin) — default TARGET_IPIRANGA */
		target?: { lat: number; lon: number };
	},
): Promise<{ dataUrl: string; width: number; height: number } | null> {
	const frames = pastFrames.slice(-FRAMES_IN_COMPOSITE);
	if (frames.length === 0) return null;

	const norm = normalizeRegion(region);
	const frameW = Math.min(norm.width, COMPOSITE_MAX_PX);
	const frameH = Math.min(norm.height, COMPOSITE_MAX_PX);
	const width = frameW * frames.length;
	const height = frameH;
	const composite = new PNG({ width, height });
	const buf = composite.data;

	for (let i = 0; i < frames.length; i++) {
		try {
			const mosaic = await fetchTileGrid(host, frames[i].path, norm);
			// redimensiona (nearest-neighbor) o mosaico para frameW x frameH
			for (let y = 0; y < frameH; y++) {
				for (let x = 0; x < frameW; x++) {
					const sx = Math.min(
						Math.floor((x / frameW) * norm.width),
						norm.width - 1,
					);
					const sy = Math.min(
						Math.floor((y / frameH) * norm.height),
						norm.height - 1,
					);
					const srcIdx = (sy * norm.width + sx) * 4;
					const dstIdx = (y * width + (i * frameW + x)) * 4;
					buf[dstIdx] = mosaic.data[srcIdx];
					buf[dstIdx + 1] = mosaic.data[srcIdx + 1];
					buf[dstIdx + 2] = mosaic.data[srcIdx + 2];
					buf[dstIdx + 3] = mosaic.data[srcIdx + 3];
				}
			}
		} catch (err) {
			logger.warn("Camada B: falha ao baixar frame para composite", {
				path: frames[i].path,
				error: String(err),
			});
		}
	}

	// ============ Anotações (grounding visual para o VLM) ============
	const target = opts?.target ?? TARGET_IPIRANGA;
	const latestTime = frames[frames.length - 1].time * 1000;
	const white: readonly [number, number, number] = [255, 255, 255];
	const red: readonly [number, number, number] = [255, 40, 40];
	const magenta: readonly [number, number, number] = [255, 0, 255];

	for (let i = 0; i < frames.length; i++) {
		const fx = i * frameW;

		// Label de tempo no topo do frame
		const deltaMin = Math.round((latestTime - frames[i].time * 1000) / 60_000);
		const timeLabel = i === frames.length - 1 ? "AGORA" : `T-${deltaMin}m`;
		drawTextOutlined(buf, width, height, fx + 6, 6, timeLabel, white);

		// Pin de Ipiranga: anel branco + centro vermelho + label
		const pin = latLonToFramePx(target.lat, target.lon, norm, frameW, frameH);
		drawCircle(buf, width, height, fx + pin.x, pin.y, 9, white);
		drawCircle(buf, width, height, fx + pin.x, pin.y, 6, red);
		drawTextOutlined(
			buf,
			width,
			height,
			fx + pin.x - 24,
			pin.y - 16,
			"IPIRANGA",
			white,
		);
	}

	// Números nos top-3 núcleos do último frame (legenda vai no prompt)
	if (opts?.latestCells && opts.latestCells.length > 0) {
		const topCells = opts.latestCells.slice(0, 3);
		const fx = (frames.length - 1) * frameW;
		for (let k = 0; k < topCells.length; k++) {
			const c = topCells[k];
			const p = latLonToFramePx(c.lat, c.lon, norm, frameW, frameH);
			const cx = fx + p.x;
			const cy = p.y;
			// círculo fora dos limites (núcleo fora da região) — ignora
			if (cx < 0 || cy < 0 || cx >= width || cy >= height) continue;
			drawCircle(buf, width, height, cx, cy, 9, white);
			drawCircle(buf, width, height, cx, cy, 7, magenta);
			drawTextOutlined(
				buf,
				width,
				height,
				cx - 2,
				cy - 3,
				String(k + 1),
				white,
			);
		}
	}

	const pngBuf = PNG.sync.write(composite);
	const dataUrl = `data:image/png;base64,${pngBuf.toString("base64")}`;
	return { dataUrl, width, height };
}

/**
 * Gera o boletim narrativo do nowcast usando o VLM da NVIDIA NIM.
 * Prompt em pt-BR pedindo análise visual dos tons + números da Camada A.
 */
export async function generateNowcastBulletin(
	nowcast: NowcastResult,
	host: string,
	pastFrames: { time: number; path: string }[],
	region: RegionSpec,
	ecmwf?: EcmwfContext,
	relevance?: {
		/** Nível de alerta da Camada A (gates de relevância) */
		alertLevel: "alert" | "watch" | "monitor" | "none";
		/** Distância do núcleo mais ameaçador (km) */
		nearestThreatKm: number | null;
	},
): Promise<NowcastBulletin> {
	// 2026-08-18 — modo DETERMINÍSTICO (Dave: "chega de IA").
	// Gera o boletim 100% pela heurística (Camada A rica portada), SEM chamar
	// VLM/LLM nenhum. Não consome cota, não faz rede, não depende de provider.
	return {
		text: buildHeuristicBulletin(nowcast, ecmwf, relevance),
		source: "heuristic",
		generatedAt: Date.now(),
	};
}


/**
 * Valida o texto gerado pelo VLM contra o veredito determinístico (Achado 2)
 * e contra a previsão numérica ECMWF (conciliação de fontes).
 * O LLM NUNCA é a fonte dos números; se o texto contradiz a Camada A, ignora
 * o ECMWF ou regurgita o prompt, é descartado e cai no fallback heurístico.
 * Retorna true quando o texto é aceitável.
 */
export function validateBulletinAgainstVerdict(
	text: string,
	verdict: ThreatVerdict | null,
	ecmwf?: EcmwfContext,
	opts?: {
		/** Nível de alerta da Camada A (gate de proporcionalidade) */
		alertLevel?: "alert" | "watch" | "monitor" | "none" | null;
		/** Distância do núcleo mais ameaçador (gate de distância omitida) */
		nearestThreatKm?: number | null;
	},
): boolean {
	// 1. Regurgitação de instruções do prompt: frases que NUNCA devem aparecer
	// no texto de saída (o modelo copiou o prompt em vez de responder).
	const promptLeaks =
		/(fonte de verdade|não invente|regra de ouro|medições determinísticas|confie neles|veredito de ameaça|análise computacional|nunca contradiga|instruções:|esquema de cores "universal blue")/i;
	if (promptLeaks.test(text)) {
		logger.warn("Camada B: texto rejeitado (regurgitação do prompt)", { text });
		return false;
	}

	// 1b. TEXTO TRUNCADO (achado 2026-08-15): boletim salvo com 46 chars
	// ("Imagens de radar de alguns minutos atrás indic") — resposta do VLM
	// interrompida no meio (safety/length), que passava pela validação por
	// não contradizer nada. Boletim real termina com pontuação final;
	// frase cortada no meio não tem. Limiar mínimo ridículo (25) só pega
	// respostas vazias tipo "Sim."/"Nada.".
	const trimmed = text.trim();
	if (trimmed.length < 25) {
		logger.warn("Camada B: texto rejeitado (curto demais, provável truncamento)", {
			len: trimmed.length,
			text: trimmed.slice(0, 120),
		});
		return false;
	}
	if (!/[.!?…"”]$/.test(trimmed)) {
		logger.warn("Camada B: texto rejeitado (sem pontuação final — truncado)", {
			text: trimmed.slice(-120),
		});
		return false;
	}

	// 2. Padrões de prompt injection / instruções embutidas no texto gerado.
	if (
		/(ignore|esqueça|esqueca|desconsidere|system prompt|instru(?:ções|coes).*(?:anterior|acima)|você agora é|a partir de agora)/i.test(
			text,
		)
	) {
		logger.warn("Camada B: texto rejeitado (padrões de injection)", { text });
		return false;
	}

	// 2b. PROPORCIONALIDADE (gate novo): o tom deve caber no nível de alerta
	// da Camada A. Em monitor/none, palavras de urgência forte são proibidas
	// (o incidente real narrou "tempestade se aproximando" com o núcleo a
	// 336 km). Em watch, só frases de alarme iminente são proibidas.
	const alertLevel = opts?.alertLevel ?? null;
	if (alertLevel && alertLevel !== "alert") {
		const alarmImminent =
			/(risco iminente|atenção imediata|perigo|emergência|temporal se aproximando|alerta vermelho|urgente)/i;
		const negated =
			/(n[ãa]o|sem|nenhum|nada de|sem risco|ausente|descarta|afasta|inexistente|n[ãa]o h[áa]|n[ãa]o existe|n[ãa]o indica|n[ãa]o apresenta|n[ãa]o traz|sem amea[çc]a|tranquil[oa])\s+.{0,50}(alerta|perigo|risco|temporal|tempestade)|(alerta|perigo|risco|temporal|tempestade)\s+.{0,25}(n[ãa]o|ausente|descartado|inexistente|nenhum|zero)/i;
		const alarmNow = alarmImminent.test(text) && !negated.test(text);
		if (alarmNow) {
			logger.warn("Camada B: texto desproporcional ao nível de alerta", {
				alertLevel,
				text,
			});
			return false;
		}
		// "alerta" solto também é proibido em monitor/none (salvo negado:
		// "sem alerta iminente" é o comportamento correto e passa).
		if (alertLevel === "monitor" || alertLevel === "none") {
			if (/\balerta\b/i.test(text) && !negated.test(text)) {
				logger.warn("Camada B: texto menciona alerta em nível monitor/none", {
					alertLevel,
					text,
				});
				return false;
			}
		}
	}

	// 2c. DISTÂNCIA OMITIDA (gate novo): núcleo a mais de 100 km e o texto
	// não menciona a distância → o cidadão não sabe que o perigo está longe.
	// (Incidente real: "núcleo se aproximando de Ipiranga" sem citar 336 km.)
	if (
		opts?.nearestThreatKm != null &&
		opts.nearestThreatKm > 100 &&
		!/\d+\s*km/i.test(text)
	) {
		logger.warn("Camada B: distância >100 km não citada no texto", {
			nearestThreatKm: opts.nearestThreatKm,
			text,
		});
		return false;
	}

	if (!verdict) return true;

	const lower = text.toLowerCase();

	// 2. Veredito AFASTANDO-SE/tangencial mas o texto sugere aproximação.
	if (verdict.approach !== "approaching") {
		const hasNegation =
			/(não|nada|nulo|praticamente nulo|sem risco|afastando|de raspão|tangencial)/i.test(
				lower,
			);
		const saysApproaching =
			/(aproximando|vindo (?:em direção|para)|chegando|rumo a|em direção a|atingir|alcançar)/i.test(
				lower,
			);
		if (saysApproaching && !hasNegation) {
			logger.warn(
				"Camada B: texto contradiz veredito (aproximação vs afastamento)",
				{ verdict: verdict.approach, text },
			);
			return false;
		}
	}

	// 3. Veredito APROXIMANDO-SE: qualquer ETA citado deve bater com o
	// calculado (tolerância de 35% — o caso real "196 min vs 1-2 horas" cai
	// fora disso e é rejeitado). Compostos "X horas e Y min" contam como um
	// único valor (ex: "3 horas e 15 minutos" = 195 min, não 3h E 15min).
	if (verdict.approach === "approaching" && verdict.etaMin != null) {
		const minutes: number[] = [];
		const consumed: Array<[number, number]> = [];
		for (const cm of text.matchAll(
			/(\d{1,2})\s*(?:horas?|h)\s*e\s+(\d{1,3})\s*(?:min|minutos?)\b/gi,
		)) {
			const total = Number(cm[1]) * 60 + Number(cm[2]);
			if (Number.isFinite(total) && total > 0) minutes.push(total);
			consumed.push([cm.index ?? 0, (cm.index ?? 0) + cm[0].length]);
		}
		const isConsumed = (idx: number): boolean =>
			consumed.some(([s, e]) => idx >= s && idx < e);
		for (const hh of text.matchAll(/(\d{1,2})\s*(?:horas?|h)\b/gi)) {
			if (isConsumed(hh.index ?? 0)) continue;
			const v = Number(hh[1]) * 60;
			if (Number.isFinite(v) && v > 0) minutes.push(v);
		}
		for (const mm of text.matchAll(/(\d{1,3})\s*(?:min|minutos?)\b/gi)) {
			if (isConsumed(mm.index ?? 0)) continue;
			const v = Number(mm[1]);
			if (Number.isFinite(v) && v > 0) minutes.push(v);
		}
		for (const c of minutes) {
			if (!Number.isFinite(c) || c <= 0) continue;
			const ratio = Math.abs(c - verdict.etaMin) / verdict.etaMin;
			if (ratio > 0.35) {
				logger.warn("Camada B: ETA citado diverge do cálculo determinístico", {
					etaVlm: c,
					etaCalc: Math.round(verdict.etaMin),
					ratio,
					text,
				});
				return false;
			}
		}
	}

	// 4. (Reconciliado com o Dave) O ECMWF NÃO é gate de aceitação: para o
	// horizonte de 1-2h o radar (nowcast) é a fonte da verdade — um boletim
	// que prioriza o radar e diz "sem alerta iminente" mesmo com ECMWF >=50%
	// é comportamento CORRETO. O ECMWF fica no prompt apenas como orientação
	// de redação (regra 8), não como critério de rejeição.

	return true;
}

/**
 * Boletim determinístico (Camada B 100%% heurística — SEM LLM).
 *
 * Porta toda a Camada A rica que antes era injetada no prompt do VLM:
 * nível de alerta + tom, núcleo mais ameaçador com município real (malha
 * IBGE) e distância até Ipiranga, veredito determinístico (aproximando /
 * afastando / tangencial + ETA), projeção da trajetória (próximas cidades)
 * e conciliação com a previsão numérica ECMWF.
 *
 * Tudo entra por PARÂMETRO de função — nada de config/env, nada de rede.
 */
export function buildHeuristicBulletin(
	nowcast: NowcastResult,
	ecmwf?: EcmwfContext,
	relevance?: {
		alertLevel?: "alert" | "watch" | "monitor" | "none";
		nearestThreatKm?: number | null;
	},
): string {
	const m = nowcast.movement;
	const dirs = ["N", "NE", "L", "SE", "S", "SO", "O", "NO"];
	const dirLabel = m ? dirs[Math.round(m.directionDeg / 45) % 8] : null;
	const intensityLabel: Record<string, string> = {
		light: "fraca",
		moderate: "moderada",
		heavy: "forte",
		extreme: "muito forte (temporal)",
	};
	const alertLevel = relevance?.alertLevel ?? "monitor";

	// Conciliação de fontes: nowcast (curto prazo) + ECMWF (horas).
	const ecmwfPct = ecmwf ? Math.round(ecmwf.rainProbabilityPct) : null;
	const ecmwfNote =
		ecmwfPct != null && ecmwfPct > 0
			? ` O modelo numérico ECMWF indica ${ecmwfPct}%% de chance de chuva nas próximas horas${
					ecmwfPct >= 50 && (!m || m.speedKmh <= 1)
						? ", mas o radar não mostra núcleos em movimento no momento (condição estável)."
						: "."
				}`
			: "";
	const ecmwfAlto = ecmwfPct != null && ecmwfPct >= 50;

	// Núcleo mais ameaçador (já avaliado pela Camada A contra Ipiranga),
	// fallback para o mais intenso. -> município real (malha IBGE) + distância.
	const cell = nowcast.threats[0] ?? nowcast.nearestCell;
	const cellMovement = cell?.movement ?? m;
	let verdict: ThreatVerdict | null = nowcast.threats[0]?.threat ?? null;
	if (cell && cellMovement && !verdict) {
		verdict = assessThreat(cell.lat, cell.lon, cellMovement, -25.0244, -50.5847);
	}

	// Sem célula analisável (radar limpo / sem núcleos).
	if (!cell) {
		if (alertLevel === "none" || alertLevel === "monitor") {
			return `Sem núcleos de chuva em movimento na região de Ipiranga no momento; sem alerta iminente.${ecmwfNote}`;
		}
		return `Núcleo de chuva ${intensityLabel[nowcast.currentDominant] ?? nowcast.currentDominant} (pico ${nowcast.currentMaxDbz} dBZ) na região de Ipiranga, mas sem movimento confiável detectado.${ecmwfNote}`;
	}

	const intensity = intensityLabel[cell.intensity] ?? intensityLabel[nowcast.currentDominant] ?? "presente";
	const rotulo = rotularLocalizacao(cell.lat, cell.lon, haversineKm);
	const rotUf = rotulo.uf ? ` (${rotulo.uf})` : "";
	const ipirangaKm = Math.round(haversineKm(cell.lat, cell.lon, -25.0244, -50.5847));

	// Veredito de ameaça determinístico.
	const approachLabel: Record<ThreatVerdict["approach"], string> = {
		approaching: `se aproximando de Ipiranga (chegada estimada em cerca de ${Math.round(verdict?.etaMin ?? 0)} min, se mantiver curso e intensidade)`,
		receding: "se afastando de Ipiranga — trajetória leva para longe, risco direto praticamente nulo",
		crossing: "em trajetória tangencial a Ipiranga (passa de raspão, sem aproximação direta)",
	};

	// Projeção da trajetória (próximas cidades em 30/60/120 min).
	let projNote = "";
	if (cellMovement) {
		const projections = [30, 60, 120]
			.map((t) => {
				const p = projectCell(cell.lat, cell.lon, cellMovement, t);
				const pr = rotularLocalizacao(p.lat, p.lon, haversineKm);
				return {
					t,
					nome: pr.municipio?.nome ?? null,
					uf: pr.municipio?.uf ?? null,
				};
			})
			.filter((p) => p.nome && p.nome !== rotulo.nome);
		if (projections.length > 0) {
			projNote = ` Podem ser afetadas à frente: ${projections
				.map((p) => `${p.nome}${p.uf ? ` (${p.uf})` : ""}`)
				.join(", ")}.`;
		}
	}

	// Frases por nível de alerta (proporcionalidade determinística).
	// ⚠️ Só descreve movimento com speedKmh > 1; velocidade ~0 = estacionário
	// (não dizer "se deslocando a 0 km/h" — frase sem sentido, pitfall skill).
	const temMovimento = Boolean(m && m.speedKmh > 1);
	const movimentoTxt = temMovimento
		? `${dirLabel ? `, deslocando-se para ${dirLabel}` : ", em movimento"} a ${m!.speedKmh} km/h`
		: ", sem movimento significativo (estacionário)";
	const baseLoc = `Núcleo de chuva ${intensity} em ${rotulo.nome}${rotUf}${rotulo.metodo}, a ${ipirangaKm} km de Ipiranga${movimentoTxt}.`;

	let corpo: string;
	if (verdict?.approach === "approaching") {
		const longe = ipirangaKm > 200 || (verdict.etaMin ?? 0) > 360;
		if (longe) {
			corpo = `${baseLoc} O núcleo ${approachLabel.approaching}, mas só chegaria em muitas horas (se não dissipar) — não há alerta iminente para Ipiranga.${projNote}`;
		} else if (alertLevel === "alert") {
			corpo = `${baseLoc} O núcleo ${approachLabel.approaching} — ALERTA: há risco real de chuva em Ipiranga nas próximas ~2 horas.${projNote}`;
		} else {
			corpo = `${baseLoc} O núcleo ${approachLabel.approaching} — acompanhe, mas ainda não é alerta para Ipiranga.${projNote}`;
		}
	} else if (verdict?.approach === "receding") {
		corpo = `${baseLoc} O núcleo está ${approachLabel.receding} — sem alerta iminente para Ipiranga.${projNote}`;
	} else if (verdict?.approach === "crossing") {
		corpo = `${baseLoc} O núcleo ${approachLabel.crossing} — risco direto baixo para Ipiranga.${projNote}`;
	} else {
		// Sem veredito confiável (sem movimento associável).
		corpo = `${baseLoc} Movimento não confiável no momento — trajetória incerta; sem alerta iminente.${ecmwfAlto ? ` Modelo ECMWF: ${ecmwfPct}%% de chuva (pode chegar às cidades à frente).` : ""}`;
	}

	return `${corpo}${ecmwfNote}`;
}
