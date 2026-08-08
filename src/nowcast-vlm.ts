import { PNG } from "pngjs";
import { loadConfig } from "./config.js";
import { logger } from "./logger.js";
import type { NowcastResult } from "./radar-analysis.js";
import { fetchTile, type TileBounds } from "./radar-analysis.js";

/**
 * Camada B — Análise não-determinística (VLM via NVIDIA NIM).
 *
 * Recebe os números da Camada A (nowcast determinístico) + o composite
 * visual dos frames de radar e pede ao VLM (Llama 3.2 Vision) um boletim
 * narrativo em português: cor dos núcleos, direção de deslocamento e se
 * há chuva vindo para Ipiranga.
 *
 * O LLM NUNCA é a fonte dos números (isso é a Camada A); ele interpreta
 * e redige a partir dos dados + imagem. Fallback para heurística se o
 * VLM falhar ou não houver chave NIM configurada.
 */

const TILE_SIZE = 256;
const FRAMES_IN_COMPOSITE = 3;

export interface NowcastBulletin {
	text: string;
	source: "nvidia_nim_vision" | "heuristic";
	generatedAt: number;
}

/**
 * Monta um composite PNG (3 tiles lado a lado = 768x256) dos frames
 * de radar da região. Retorna base64 data-URL para enviar ao VLM.
 */
export async function buildRadarComposite(
	host: string,
	pastFrames: { time: number; path: string }[],
	bounds: TileBounds,
): Promise<{ dataUrl: string; width: number; height: number } | null> {
	const frames = pastFrames.slice(-FRAMES_IN_COMPOSITE);
	if (frames.length === 0) return null;

	const width = TILE_SIZE * frames.length;
	const height = TILE_SIZE;
	const composite = new PNG({ width, height });

	for (let i = 0; i < frames.length; i++) {
		try {
			const tile = await fetchTile(host, frames[i].path, bounds);
			const src = tile.data;
			// copia pixel a pixel para o composite
			for (let y = 0; y < TILE_SIZE; y++) {
				for (let x = 0; x < TILE_SIZE; x++) {
					const srcIdx = (y * TILE_SIZE + x) * 4;
					const dstIdx = (y * width + (i * TILE_SIZE + x)) * 4;
					composite.data[dstIdx] = src[srcIdx];
					composite.data[dstIdx + 1] = src[srcIdx + 1];
					composite.data[dstIdx + 2] = src[srcIdx + 2];
					composite.data[dstIdx + 3] = src[srcIdx + 3];
				}
			}
		} catch (err) {
			logger.warn("Camada B: falha ao baixar frame para composite", {
				path: frames[i].path,
				error: String(err),
			});
		}
	}

	const buf = PNG.sync.write(composite);
	const dataUrl = `data:image/png;base64,${buf.toString("base64")}`;
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
	bounds: TileBounds,
): Promise<NowcastBulletin> {
	const config = loadConfig();
	const apiKey = config.nvidiaNimApiKey;

	// Sem chave NIM → fallback heurístico (não faz sentido chamar VLM)
	if (!apiKey) {
		return {
			text: buildHeuristicBulletin(nowcast),
			source: "heuristic",
			generatedAt: Date.now(),
		};
	}

	try {
		const composite = await buildRadarComposite(host, pastFrames, bounds);
		if (!composite) {
			return {
				text: buildHeuristicBulletin(nowcast),
				source: "heuristic",
				generatedAt: Date.now(),
			};
		}

		const m = nowcast.movement;
		const dirs = ["N", "NE", "L", "SE", "S", "SO", "O", "NO"];
		const dirLabel = m ? dirs[Math.round(m.directionDeg / 45) % 8] : null;
		const intensityLabel: Record<string, string> = {
			light: "fraca",
			moderate: "moderada",
			heavy: "forte",
			extreme: "muito forte (temporal)",
		};

		const prompt = `Você é um meteorologista analisando imagens de radar meteorológico (RainViewer, esquema de cores "Universal Blue").
A imagem mostra 3 frames consecutivos do radar (esquerda = mais antigo, direita = mais recente) da região de Ipiranga/PR, com intervalo de ~10 minutos cada.

DADOS DA ANÁLISE COMPUTACIONAL (medições determinísticas, confie neles):
- Intensidade dominante: ${intensityLabel[nowcast.currentDominant] ?? nowcast.currentDominant} (pico ${nowcast.currentMaxDbz} dBZ)
- Movimento do núcleo mais intenso: ${m ? `direção ${m.directionDeg}° (${dirLabel}), ${m.speedKmh} km/h` : "sem movimento detectado"}
- Frames analisados: ${nowcast.frames.length}

Instruções:
1. Observe as cores na imagem: azul/âmbar = chuva fraca, azul-escuro = moderada, amarelo/laranja = forte, vermelho/rosa = temporal.
2. Confirme se o deslocamento visual do núcleo bate com a direção medida.
3. Responda em português brasileiro, no máximo 3 frases, informando ao cidadão de Ipiranga se está vindo chuva e o que esperar nas próximas 1-2 horas.
4. Se o núcleo estiver distante ou sem movimento, diga que não há alerta iminente.
5. Termine com uma recomendação prática (levar guarda-chuva, atenção à rede elétrica, etc.) se houver risco.

NÃO invente números além dos fornecidos. Seja direto e útil.`;

		const response = await fetch(config.nvidiaNimEndpoint, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				model: "meta/llama-3.2-90b-vision-instruct",
				messages: [
					{
						role: "user",
						content: [
							{ type: "text", text: prompt },
							{
								type: "image_url",
								image_url: { url: composite.dataUrl },
							},
						],
					},
				],
				max_tokens: 300,
				temperature: 0.4,
			}),
			signal: AbortSignal.timeout(30_000),
		});

		if (!response.ok) {
			throw new Error(`NIM vision HTTP ${response.status}`);
		}

		const json = (await response.json()) as {
			choices?: Array<{ message?: { content?: string } }>;
		};
		const text = json.choices?.[0]?.message?.content?.trim();
		if (!text) throw new Error("VLM retornou vazio");

		logger.info("Camada B: boletim nowcast gerado via NIM vision", {
			model: "meta/llama-3.2-90b-vision-instruct",
		});
		return { text, source: "nvidia_nim_vision", generatedAt: Date.now() };
	} catch (err) {
		logger.warn("Camada B: VLM falhou, usando heurística", {
			error: String(err),
		});
		return {
			text: buildHeuristicBulletin(nowcast),
			source: "heuristic",
			generatedAt: Date.now(),
		};
	}
}

/** Fallback determinístico quando o VLM não está disponível */
function buildHeuristicBulletin(nowcast: NowcastResult): string {
	const m = nowcast.movement;
	const dirs = ["N", "NE", "L", "SE", "S", "SO", "O", "NO"];
	const dirLabel = m ? dirs[Math.round(m.directionDeg / 45) % 8] : null;
	const intensityLabel: Record<string, string> = {
		light: "fraca",
		moderate: "moderada",
		heavy: "forte",
		extreme: "muito forte (temporal)",
	};

	if (!m) {
		return "Sem núcleos de chuva significativos em movimento na região de Ipiranga no momento.";
	}

	return `Núcleo de chuva ${intensityLabel[nowcast.currentDominant] ?? nowcast.currentDominant} (pico ${nowcast.currentMaxDbz} dBZ) deslocando-se para ${dirLabel} a ${m.speedKmh} km/h. Observação baseada em ${m.intervalMin} min de frames de radar.`;
}
