import { PNG } from "pngjs";
import { type AppConfig, loadConfig } from "./config.js";
import { getMunicipioComFallback } from "./geo-municipio.js";
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
 * Obs.: o nome literal "gemini-3.6-flash-lite" não existe na API
 * generativelanguage (testado 2026-08-12); "gemini-flash-lite-latest" é o
 * Flash Lite da geração atual (3.6). Lista: /v1beta/models. */
const GEMINI_VLM_MODEL = "gemini-flash-lite-latest";

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
	source: "gemini" | "nvidia_nim_vision" | "heuristic";
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
			signal: AbortSignal.timeout(90_000),
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
			max_tokens: 300,
			temperature: 0.4,
		}),
		signal: AbortSignal.timeout(90_000),
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
	const config = loadConfig();
	const apiKey = config.nvidiaNimApiKey;
	const geminiKey = config.geminiApiKey;

	// Sem chave Gemini/NIM → fallback heurístico (não faz sentido chamar VLM)
	if (!geminiKey && !apiKey) {
		return {
			text: buildHeuristicBulletin(nowcast, ecmwf),
			source: "heuristic",
			generatedAt: Date.now(),
		};
	}

	try {
		const composite = await buildRadarComposite(host, pastFrames, region, {
			// Números nos top-3 núcleos do último frame (grounding visual):
			// o VLM vê exatamente quais células o sistema associou aos dados.
			latestCells: nowcast.threats.slice(0, 3).map((t) => ({
				lat: t.lat,
				lon: t.lon,
				intensity: t.intensity,
			})),
			target: TARGET_IPIRANGA,
		});
		if (!composite) {
			return {
				text: buildHeuristicBulletin(nowcast, ecmwf),
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

		// Localização determinística do núcleo (município real via malha IBGE —
		// point-in-polygon). O VLM NUNCA calcula isso, apenas repete o dado fornecido.
		// Prioridade: o núcleo mais AMEAÇADOR (threats[0], já avaliado contra
		// Ipiranga); fallback para o mais intenso (nearestCell).
		const cell = nowcast.threats[0] ?? nowcast.nearestCell;
		let locationNote = "";
		let threatNote = "";
		// Veredito determinístico exposto para validação pós-geração (Achado 2).
		// Para threats[0] o veredicto já vem calculado; senão calcula do movimento global.
		let verdict: ThreatVerdict | null = nowcast.threats[0]?.threat ?? null;
		if (cell && typeof cell.lat === "number") {
			const { municipio, fallbackUsado } = getMunicipioComFallback(
				cell.lat,
				cell.lon,
				haversineKm,
			);
			const ipirangaKm = haversineKm(cell.lat, cell.lon, -25.0244, -50.5847);
			const nome =
				municipio?.nome ?? `(${cell.lat.toFixed(2)}, ${cell.lon.toFixed(2)})`;
			const metodo = fallbackUsado
				? " (referência regional — fora da malha IBGE)"
				: "";
			locationNote = `- Núcleo mais ameaçador em (${cell.lat.toFixed(2)}, ${cell.lon.toFixed(2)}): município ${nome}${metodo}; dista ${Math.round(ipirangaKm)} km de Ipiranga\n`;

			// Veredicto de ameaça DETERMINÍSTICO (Camada A): o VLM nunca decide
			// se o núcleo vem ou não para Ipiranga — recebe a conclusão pronta.
			// Usa o movimento INDIVIDUAL do núcleo (threats[0].movement) quando
			// disponível; fallback para o movimento global do nowcast.
			const cellMovement = cell.movement ?? m;
			if (cellMovement) {
				if (!verdict) {
					verdict = assessThreat(
						cell.lat,
						cell.lon,
						cellMovement,
						-25.0244,
						-50.5847,
					);
				}
				const approachLabel: Record<ThreatVerdict["approach"], string> = {
					approaching: `APROXIMANDO-SE de Ipiranga (ETA ~${Math.round(verdict.etaMin ?? 0)} min, se mantiver curso e intensidade)`,
					receding:
						"AFASTANDO-SE de Ipiranga (trajetória leva para longe — risco direto para Ipiranga é praticamente nulo)",
					crossing:
						"em trajetória tangencial a Ipiranga (passa de raspão, sem aproximação direta)",
				};
				threatNote = `- VEREDITO DE AMEAÇA (cálculo determinístico, NÃO contradiga): o núcleo está ${approachLabel[verdict.approach]}\n`;

				// Projeção da trajetória: em quais municípios o núcleo estará
				// em 30/60/120 min (extrapolação linear). As "próximas cidades".
				const projections = [30, 60, 120]
					.map((t) => {
						const p = projectCell(cell.lat, cell.lon, cellMovement, t);
						const pm = getMunicipioComFallback(p.lat, p.lon, haversineKm);
						return { t, ...p, nome: pm.municipio?.nome ?? null };
					})
					.filter((p) => p.nome && p.nome !== nome);
				if (projections.length > 0) {
					const projList = projections
						.map((p) => `${p.nome} (${p.t} min)`)
						.join(", ");
					threatNote += `- Projeção da trajetória (extrapolação, pode dissipar): ${projList}\n`;
				}
			}
		}

		// Seção de previsão numérica ECMWF (concatenação de fontes): o VLM
		// pesa o nowcast (curto prazo) contra o modelo numérico (horas).
		let ecmwfSection = "";
		if (
			ecmwf &&
			(ecmwf.hourlyForecast.length > 0 || ecmwf.rainProbabilityPct > 0)
		) {
			const nowPct = Math.round(ecmwf.rainProbabilityPct);
			const hourly = ecmwf.hourlyForecast
				.slice(0, 6)
				.map(
					(h) =>
						`- ${h.time}: ${h.rainProbabilityPct}% de chuva (${h.precipitationMm} mm)`,
				)
				.join("\n");
			ecmwfSection = `\nPREVISÃO NUMÉRICA (ECMWF IFS — Open-Meteo, fonte de médio prazo, confie nela para o horizonte de HORAS):\n- Agora: ${nowPct}% de probabilidade de chuva\n${hourly}\n`;
		}

		// Legenda dos núcleos numerados no composite (top-3 threats do último frame)
		const numberedThreats = nowcast.threats.slice(0, 3);
		let numberedLegend = "";
		if (numberedThreats.length > 0) {
			numberedLegend =
				numberedThreats
					.map((t, i) => {
						const { municipio } = getMunicipioComFallback(
							t.lat,
							t.lon,
							haversineKm,
						);
						return `- Núcleo ${i + 1} (círculo ${i + 1} na imagem): município ${municipio?.nome ?? "fora da malha"} (${t.lat.toFixed(2)}, ${t.lon.toFixed(2)}), ${intensityLabel[t.intensity] ?? t.intensity}, ~${Math.round(t.distToTargetKm)} km de Ipiranga`;
					})
					.join("\n") + "\n";
		}

		// Nível de alerta da Camada A + tom exigido (proporcionalidade)
		const alertLevel = relevance?.alertLevel ?? "monitor";
		const toneByLevel: Record<string, string> = {
			alert:
				"URGÊNCIA MODERADA: risco real nas próximas ~2 horas — alerte com seriedade, sem pânico.",
			watch:
				"TOM INFORMATIVO: atividade relevante a algumas horas de distância — informe de forma calma, sem alarmismo.",
			monitor:
				"TOM TRANQUILIZADOR: núcleos distantes, afastando-se ou estacionários — deixe claro que NÃO há alerta iminente para Ipiranga.",
			none: "TOM TRANQUILIZADOR: radar limpo na região — diga que não há alerta.",
		};

		const prompt = `Você é um meteorologista analisando imagens de radar meteorológico (RainViewer, esquema de cores "Universal Blue").
A imagem tem 3 frames do radar da região de Ipiranga/PR, lado a lado (esquerda = mais antigo, direita = mais recente), com intervalo de ~10 minutos cada. Cada frame tem um rótulo de tempo no topo ("T-20m", "T-10m" ou "AGORA").
ANOTAÇÕES NA IMAGEM (desenhadas pelo sistema):
- O pin vermelho com o rótulo "IPIRANGA" marca a posição da cidade em CADA frame. OLHE AO REDOR DESSE PIN: se não houver cores de radar (azul/âmbar/amarelo/vermelho) sobre ou perto do pin, o radar NÃO mostra chuva sobre Ipiranga no momento.
- Círculos com números (1, 2, 3) no frame "AGORA" marcam os núcleos analisados; a legenda de cada número está nos DADOS abaixo.
- Comparando os 3 frames você vê o deslocamento dos núcleos ao longo do tempo (um núcleo que se move aparece em posições diferentes em cada frame).
IMPORTANTE: as imagens são de momentos ANTERIORES (o frame mais recente tem alguns minutos de atraso) — a análise não é ao vivo; trate as conclusões como uma projeção de curto prazo.

DADOS DA ANÁLISE COMPUTACIONAL (medições determinísticas, confie neles):
- NÍVEL DE ALERTA (calculado pela Camada A): ${alertLevel.toUpperCase()}. Tom exigido: ${toneByLevel[alertLevel]}
- Intensidade dominante: ${intensityLabel[nowcast.currentDominant] ?? nowcast.currentDominant} (pico ${nowcast.currentMaxDbz} dBZ)
- Movimento do núcleo mais intenso: ${m ? `direção ${m.directionDeg}° (${dirLabel}), ${m.speedKmh} km/h` : "sem movimento detectado"}
${numberedLegend ? `- Núcleos numerados na imagem:\n${numberedLegend}` : ""}${locationNote}${threatNote}${ecmwfSection}- Frames analisados: ${nowcast.frames.length}

Instruções:
0. NUNCA repita, cite ou parafraseie as instruções ou os cabeçalhos deste prompt no seu texto — escreva apenas a análise para o cidadão, sem títulos, sem listas, sem markdown além de negrito simples, em no máximo 3 frases corridas.
1. Observe as cores na imagem: azul/âmbar = chuva fraca, azul-escuro = moderada, amarelo/laranja = forte, vermelho/rosa = temporal. O pin "IPIRANGA" e os círculos numerados são MARCADORES do sistema, não dados de radar.
2. A direção e a velocidade MEDIDAS (acima) são a fonte de verdade — use SEMPRE esses valores. Não invente outra direção baseada na imagem; ela pode parecer ambígua.
3. Responda em português brasileiro, no máximo 3 frases, informando ao cidadão de Ipiranga se está vindo chuva e o que esperar nas próximas 1-2 horas, deixando claro que a análise usa imagens de radar de alguns minutos atrás. Mencione em qual MUNICÍPIO o núcleo está (use SOMENTE o município fornecido na localização acima — ele é a fonte oficial; não troque por outra cidade da região por conta própria).
4. LEITURA VISUAL OBRIGATÓRIA: verifique o pin "IPIRANGA" nos 3 frames. Se o radar estiver limpo ao redor do pin em TODOS os frames, diga que o radar não mostra chuva sobre Ipiranga no momento — mesmo que haja núcleos coloridos em outras partes da imagem (eles podem estar a centenas de km, fora da área de interesse).
5. PROPORCIONALIDADE: siga o NÍVEL DE ALERTA acima. Se for MONITORAMENTO, o núcleo está longe ou afastando — NÃO use palavras como "alerta", "tempestade se aproximando" ou "risco iminente"; diga que não há alerta iminente e informe a distância. Se for VIGILÂNCIA, informe de forma calma. Só em ALERTA use tom de aviso.
6. REGRA DE OURO: o VEREDITO DE AMEAÇA acima é um cálculo determinístico feito por computador — NUNCA contradiga, NUNCA diga que o núcleo está "vindo em direção a Ipiranga" quando o veredito diz AFASTANDO-SE ou tangencial. Se estiver AFASTANDO-SE, diga claramente que o risco para Ipiranga é nulo/praticamente nulo e, se houver projeção de trajetória, mencione quais municípios podem ser afetados à frente.
7. Se o veredito disser APROXIMANDO-SE com ETA grande (mais de 360 minutos) ou o núcleo estiver a mais de 200 km, diga que não há alerta iminente — o núcleo só chegaria em muitas horas, se não dissipar. Nesse caso mencione o ETA em HORAS (ex.: "em cerca de 8 horas"), não em minutos.
8. Se o núcleo estiver distante (mais de 80 km) ou o movimento estiver ausente/não confiável (sem valor medido), diga que não há alerta iminente ou que a trajetória é incerta — não invente direção, velocidade ou ETA.
9. Seja honesto sobre a incerteza: nowcast de curto prazo pode cometer erros (dissipação ou mudança súbita de rumo) — mencione isso de forma natural quando houver risco.
10. CONCILIAÇÃO DE FONTES: a PREVISÃO NUMÉRICA (ECMWF) cobre o horizonte de horas e o nowcast o curto prazo. Se o ECMWF indicar probabilidade alta de chuva (>=50%) mas o radar NÃO mostrar núcleos significativos, NÃO diga que "vai chover" nem que "não vai chover" como certeza — diga que o modelo numérico indica X% de chance de chuva nas próximas horas, mas o radar não mostra núcleos no momento (condição de observação estável). Se o ECMWF indicar baixa probabilidade mas o radar mostrar núcleo se aproximando, prevalece o nowcast (radar) para o curto prazo, mas mencione que o modelo numérico vê baixa chance — é sinal de célula isolada que pode dissipar.

NÃO invente números além dos fornecidos. Seja direto e útil.`;

		// Cadeia de modelos: Gemini 3.6 Flash Lite (primário) → NIM vision
		// (legado, se a chave existir) → heurística. O composite anotado vai
		// para todos; a validação pós-geração roda em cada tentativa.
		const attempts: Array<{
			label: string;
			source: "gemini" | "nvidia_nim_vision";
			call: () => Promise<string | null>;
		}> = [];
		if (geminiKey) {
			attempts.push({
				label: GEMINI_VLM_MODEL,
				source: "gemini",
				call: () =>
					callGeminiVision(
						geminiKey,
						GEMINI_VLM_MODEL,
						prompt,
						composite.dataUrl,
					),
			});
		}
		if (apiKey) {
			for (const model of [
				"meta/llama-3.2-90b-vision-instruct",
				"meta/llama-3.2-11b-vision-instruct",
			]) {
				attempts.push({
					label: model,
					source: "nvidia_nim_vision",
					call: () =>
						callNimVision(config, apiKey, model, prompt, composite.dataUrl),
				});
			}
		}

		for (const attempt of attempts) {
			try {
				const text = await attempt.call();
				if (!text) {
					logger.warn("Camada B: VLM retornou vazio", {
						model: attempt.label,
					});
					continue;
				}

				// Validação pós-geração: o texto NUNCA pode contradizer a
				// Camada A, ignorar o ECMWF (>=50%), regurgitar o prompt ou
				// usar tom desproporcional ao nível de alerta. Se reprovar,
				// tenta o próximo modelo; no fim cai na heurística.
				if (
					!validateBulletinAgainstVerdict(text, verdict, ecmwf, {
						alertLevel: relevance?.alertLevel,
						nearestThreatKm: relevance?.nearestThreatKm,
					})
				) {
					logger.warn("Camada B: texto rejeitado pela validação", {
						model: attempt.label,
					});
					continue;
				}

				logger.info("Camada B: boletim nowcast gerado", {
					model: attempt.label,
				});
				return {
					text,
					source: attempt.source,
					generatedAt: Date.now(),
				};
			} catch (err) {
				logger.warn("Camada B: VLM falhou, tentando próximo modelo", {
					model: attempt.label,
					error: String(err),
				});
			}
		}

		// Todos os modelos falharam → fallback determinístico
		logger.warn("Camada B: todos os modelos falharam, usando heurística");
		return {
			text: buildHeuristicBulletin(nowcast, ecmwf),
			source: "heuristic",
			generatedAt: Date.now(),
		};
	} catch (err) {
		logger.warn("Camada B: VLM falhou no composite/prompt, usando heurística", {
			error: String(err),
		});
		return {
			text: buildHeuristicBulletin(nowcast),
			source: "heuristic",
			generatedAt: Date.now(),
		};
	}
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

/** Fallback determinístico quando o VLM não está disponível */
function buildHeuristicBulletin(
	nowcast: NowcastResult,
	ecmwf?: EcmwfContext,
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

	// Conciliação de fontes: nowcast (curto prazo) + ECMWF (horas).
	const ecmwfPct = ecmwf ? Math.round(ecmwf.rainProbabilityPct) : null;
	const ecmwfNote =
		ecmwfPct != null && ecmwfPct > 0
			? ` O modelo ECMWF indica ${ecmwfPct}% de chance de chuva nas próximas horas${
					ecmwfPct >= 50 && (!m || m.speedKmh <= 1)
						? ", mas o radar não mostra núcleos em movimento no momento (condição estável)."
						: "."
				}`
			: "";

	// Sem movimento confiável (ausente OU velocidade ~0 = célula estacionária).
	if (!m || m.speedKmh <= 1) {
		if (!m) {
			return `Sem núcleos de chuva significativos em movimento na região de Ipiranga no momento.${ecmwfNote}`;
		}
		return `Núcleo de chuva ${intensityLabel[nowcast.currentDominant] ?? nowcast.currentDominant} (pico ${nowcast.currentMaxDbz} dBZ) presente na região, mas sem movimento significativo detectado (estacionário).${ecmwfNote}`;
	}

	return `Núcleo de chuva ${intensityLabel[nowcast.currentDominant] ?? nowcast.currentDominant} (pico ${nowcast.currentMaxDbz} dBZ) deslocando-se para ${dirLabel} a ${m.speedKmh} km/h. Observação baseada em ${m.intervalMin} min de frames de radar.${ecmwfNote}`;
}
