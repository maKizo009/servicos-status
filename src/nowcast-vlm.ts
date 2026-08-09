import { PNG } from "pngjs";
import { loadConfig } from "./config.js";
import { logger } from "./logger.js";
import type { NowcastResult } from "./radar-analysis.js";
import {
	fetchTileGrid,
	haversineKm,
	normalizeRegion,
	type RegionSpec,
} from "./radar-analysis.js";

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

const FRAMES_IN_COMPOSITE = 3;

/** Cidades da região (Campos Gerais/PR + vizinhança) para referência geográfica do VLM. */
const REGION_CITIES: ReadonlyArray<{ name: string; lat: number; lon: number }> =
	[
		{ name: "Ipiranga", lat: -25.0244, lon: -50.5847 },
		{ name: "Ponta Grossa", lat: -25.095, lon: -50.158 },
		{ name: "Tibagi", lat: -24.512, lon: -50.414 },
		{ name: "Telêmaco Borba", lat: -24.324, lon: -50.616 },
		{ name: "Imbituva", lat: -25.229, lon: -50.6 },
		{ name: "Prudentópolis", lat: -25.212, lon: -50.978 },
		{ name: "Reserva", lat: -24.65, lon: -50.85 },
		{ name: "Carambeí", lat: -24.952, lon: -50.103 },
		{ name: "Castro", lat: -24.79, lon: -50.011 },
		{ name: "Piraí do Sul", lat: -24.526, lon: -49.948 },
		{ name: "Jaguariaíva", lat: -24.252, lon: -49.706 },
		{ name: "Arapoti", lat: -24.16, lon: -49.827 },
		{ name: "Ventania", lat: -24.246, lon: -50.242 },
		{ name: "Ortigueira", lat: -24.208, lon: -50.944 },
		{ name: "Curitiba", lat: -25.429, lon: -49.271 },
		{ name: "Palmeira", lat: -25.429, lon: -50.003 },
		{ name: "Teixeira Soares", lat: -25.369, lon: -50.46 },
		{ name: "São João do Triunfo", lat: -25.683, lon: -50.295 },
		{ name: "Ivaí", lat: -25.008, lon: -50.858 },
		{ name: "Campina Grande do Sul", lat: -25.305, lon: -49.055 },
	];

/** Cidade da lista mais próxima de um ponto (haversine, determinístico). */
function nearestCity(
	lat: number,
	lon: number,
): { name: string; distanceKm: number } {
	let best: { name: string; distanceKm: number } | null = null;
	for (const c of REGION_CITIES) {
		const d = haversineKm(lat, lon, c.lat, c.lon);
		if (!best || d < best.distanceKm) {
			best = { name: c.name, distanceKm: d };
		}
	}
	return best ?? { name: "região", distanceKm: 0 };
}

export interface NowcastBulletin {
	text: string;
	source: "nvidia_nim_vision" | "heuristic";
	generatedAt: number;
}

/**
 * Monta um composite PNG dos frames de radar da região (mosaico reduzido).
 * Cada frame vira uma "coluna" do composite; mosaicos grandes (grid z=9)
 * são reduzidos para no máximo COMPOSITE_MAX_PX por lado (nearest-neighbor)
 * para não explodir o payload do VLM.
 */
const COMPOSITE_MAX_PX = 512;

export async function buildRadarComposite(
	host: string,
	pastFrames: { time: number; path: string }[],
	region: RegionSpec,
): Promise<{ dataUrl: string; width: number; height: number } | null> {
	const frames = pastFrames.slice(-FRAMES_IN_COMPOSITE);
	if (frames.length === 0) return null;

	const norm = normalizeRegion(region);
	const frameW = Math.min(norm.width, COMPOSITE_MAX_PX);
	const frameH = Math.min(norm.height, COMPOSITE_MAX_PX);
	const width = frameW * frames.length;
	const height = frameH;
	const composite = new PNG({ width, height });

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
					composite.data[dstIdx] = mosaic.data[srcIdx];
					composite.data[dstIdx + 1] = mosaic.data[srcIdx + 1];
					composite.data[dstIdx + 2] = mosaic.data[srcIdx + 2];
					composite.data[dstIdx + 3] = mosaic.data[srcIdx + 3];
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
	region: RegionSpec,
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
		const composite = await buildRadarComposite(host, pastFrames, region);
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

		// Localização determinística do núcleo (cidade mais próxima via haversine) —
		// o VLM NUNCA calcula isso, apenas repete o dado fornecido.
		const cell = nowcast.nearestCell;
		let locationNote = "";
		if (cell && typeof cell.lat === "number") {
			const city = nearestCity(cell.lat, cell.lon);
			const ipirangaKm = haversineKm(cell.lat, cell.lon, -25.0244, -50.5847);
			locationNote = `- Núcleo mais intenso em (${cell.lat.toFixed(2)}, ${cell.lon.toFixed(2)}): cidade mais próxima ${city.name} (a ${Math.round(city.distanceKm)} km); dista ${Math.round(ipirangaKm)} km de Ipiranga\n`;
		}

		const prompt = `Você é um meteorologista analisando imagens de radar meteorológico (RainViewer, esquema de cores "Universal Blue").
A imagem mostra 3 frames consecutivos do radar (esquerda = mais antigo, direita = mais recente) da região de Ipiranga/PR, com intervalo de ~10 minutos cada.
IMPORTANTE: as imagens são de momentos ANTERIORES (o frame mais recente tem alguns minutos de atraso) — a análise não é ao vivo; trate as conclusões como uma projeção de curto prazo.

DADOS DA ANÁLISE COMPUTACIONAL (medições determinísticas, confie neles):
- Intensidade dominante: ${intensityLabel[nowcast.currentDominant] ?? nowcast.currentDominant} (pico ${nowcast.currentMaxDbz} dBZ)
- Movimento do núcleo mais intenso: ${m ? `direção ${m.directionDeg}° (${dirLabel}), ${m.speedKmh} km/h` : "sem movimento detectado"}
${locationNote}- Frames analisados: ${nowcast.frames.length}

Instruções:
1. Observe as cores na imagem: azul/âmbar = chuva fraca, azul-escuro = moderada, amarelo/laranja = forte, vermelho/rosa = temporal.
2. A direção e a velocidade MEDIDAS (acima) são a fonte de verdade — use SEMPRE esses valores. Não invente outra direção baseada na imagem; ela pode parecer ambígua.
3. Responda em português brasileiro, no máximo 3 frases, informando ao cidadão de Ipiranga se está vindo chuva e o que esperar nas próximas 1-2 horas, deixando claro que a análise usa imagens de radar de alguns minutos atrás. Mencione em qual cidade/região o núcleo está (use a localização fornecida acima). Se o núcleo estiver longe de Ipiranga (mais de 80 km), diga que o risco direto para Ipiranga é menor, sem alarmismo.
4. Se o núcleo estiver distante ou o movimento estiver ausente/não confiável (sem valor medido), diga que não há alerta iminente ou que a trajetória é incerta — não invente direção ou velocidade.
5. Seja honesto sobre a incerteza: nowcast de curto prazo pode cometer erros (dissipação ou mudança súbita de rumo) — mencione isso de forma natural quando houver risco.

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
