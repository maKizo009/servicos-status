import { PNG } from "pngjs";
import { logger } from "./logger.js";
import type { RainViewerFrame } from "./types.js";

/**
 * Análise determinística de radar RainViewer (Camada A do nowcast).
 *
 * Pipeline:
 *  1. Baixa tiles PNG dos frames (t-20, t-10, agora)
 *  2. Decodifica PNG e classifica cada pixel pela paleta oficial
 *     "Universal Blue" (Rain) do RainViewer → dBZ aproximado
 *  3. Agrupa pixels por intensidade e calcula centroide de cada núcleo
 *  4. Converte centroide (px→lat/lon, Web Mercator) e rastreia o
 *     deslocamento entre frames → direção, velocidade e ETA
 *
 * Fonte da paleta: https://www.rainviewer.com/api/color-schemes.html
 * (coluna "Rain" do esquema Universal Blue, color=2)
 */

// ============ Paleta oficial Universal Blue (Rain) ============
// dBZ → RGBA. Amostrada a cada 5 dBZ da tabela oficial de 256 entradas.
// (Os pontos intermediários são interpolados na classificação.)
const PALETTE: ReadonlyArray<{
	dbz: number;
	r: number;
	g: number;
	b: number;
	a: number;
}> = [
	{ dbz: -32, r: 0, g: 0, b: 0, a: 0 },
	{ dbz: -27, r: 0, g: 0, b: 0, a: 0 },
	{ dbz: -22, r: 0, g: 0, b: 0, a: 0 },
	{ dbz: -17, r: 0, g: 0, b: 0, a: 0 },
	{ dbz: -12, r: 0, g: 0, b: 0, a: 0 },
	{ dbz: -7, r: 108, g: 104, b: 93, a: 36 },
	{ dbz: -2, r: 124, g: 117, b: 101, a: 62 },
	{ dbz: 3, r: 139, g: 130, b: 109, a: 89 },
	{ dbz: 8, r: 182, g: 169, b: 126, a: 130 },
	{ dbz: 13, r: 218, g: 204, b: 147, a: 180 },
	{ dbz: 18, r: 54, g: 186, b: 229, a: 255 },
	{ dbz: 23, r: 0, g: 136, b: 191, a: 255 },
	{ dbz: 28, r: 0, g: 98, b: 149, a: 255 },
	{ dbz: 33, r: 0, g: 74, b: 112, a: 255 },
	{ dbz: 38, r: 255, g: 197, b: 0, a: 255 },
	{ dbz: 43, r: 255, g: 139, b: 0, a: 255 },
	{ dbz: 48, r: 217, g: 27, b: 0, a: 255 },
	{ dbz: 53, r: 118, g: 0, b: 0, a: 255 },
	{ dbz: 58, r: 255, g: 139, b: 255, a: 255 },
	{ dbz: 63, r: 255, g: 88, b: 255, a: 255 },
	{ dbz: 68, r: 255, g: 255, b: 255, a: 255 },
	{ dbz: 73, r: 255, g: 255, b: 255, a: 255 },
	{ dbz: 78, r: 0, g: 255, b: 0, a: 255 },
	{ dbz: 83, r: 0, g: 255, b: 0, a: 255 },
	{ dbz: 88, r: 0, g: 255, b: 0, a: 255 },
	{ dbz: 93, r: 0, g: 255, b: 0, a: 255 },
];

/** Limiares de intensidade (dBZ) — padrão meteorológico comum */
export const INTENSITY_THRESHOLDS = {
	light: 5, //   5–19 dBZ: chuva fraca (âmbar/azul claro)
	moderate: 20, // 20–37 dBZ: chuva moderada (azul)
	heavy: 38, //   38–47 dBZ: chuva forte (amarelo/laranja)
	extreme: 48, //  48+ dBZ:  muito forte/temporal (vermelho/rosa)
} as const;

export type RainIntensity = "none" | "light" | "moderate" | "heavy" | "extreme";

export interface ClassifiedPixel {
	x: number;
	y: number;
	dbz: number;
	intensity: RainIntensity;
}

export interface RainCell {
	intensity: Exclude<RainIntensity, "none">;
	pixelCount: number;
	maxDbz: number;
	meanDbz: number;
	/** Centroide em pixels do tile (0-255) */
	centroidX: number;
	centroidY: number;
	/** Centroide geográfico (Web Mercator) */
	lat: number;
	lon: number;
}

export interface FrameAnalysis {
	/** Timestamp epoch (ms) do frame */
	time: number;
	cells: RainCell[];
	/** dBZ máximo encontrado no tile */
	maxDbz: number;
	/** Fração do tile com precipitação (0-1) */
	coverage: number;
}

export interface MovementVector {
	/** Direção de deslocamento em graus (0=N, 90=L, 180=S, 270=O) */
	directionDeg: number;
	/** Velocidade em km/h */
	speedKmh: number;
	/** Intervalo entre os dois frames em minutos */
	intervalMin: number;
	/** Deslocamento em pixels do tile */
	dxPx: number;
	dyPx: number;
	/** Centroide de origem (frame mais antigo) */
	fromLat: number;
	fromLon: number;
	toLat: number;
	toLon: number;
}

// ============ Classificação de pixel ============

/**
 * Aproxima o dBZ de um pixel comparando com a paleta oficial.
 * Usa distância euclidiana RGB; alpha baixo (<40) = sem dados.
 */
export function classifyPixel(
	r: number,
	g: number,
	b: number,
	a: number,
): ClassifiedPixel | null {
	if (a < 40) return null;
	let best: { dbz: number; r: number; g: number; b: number; a: number } | null =
		null;
	let bestDist = Infinity;
	for (const entry of PALETTE) {
		const dr = r - entry.r;
		const dg = g - entry.g;
		const db = b - entry.b;
		const dist = dr * dr + dg * dg + db * db;
		if (dist < bestDist) {
			bestDist = dist;
			best = entry;
		}
	}
	if (!best || best.dbz < INTENSITY_THRESHOLDS.light) {
		// dBZ < 5 = chuva desprezível; conta como none
		return best
			? { x: 0, y: 0, dbz: best.dbz, intensity: "none" as const }
			: null;
	}
	return { x: 0, y: 0, dbz: best.dbz, intensity: intensityFromDbz(best.dbz) };
}

export function intensityFromDbz(dbz: number): RainIntensity {
	if (dbz < INTENSITY_THRESHOLDS.light) return "none";
	if (dbz < INTENSITY_THRESHOLDS.moderate) return "light";
	if (dbz < INTENSITY_THRESHOLDS.heavy) return "moderate";
	if (dbz < INTENSITY_THRESHOLDS.extreme) return "heavy";
	return "extreme";
}

// ============ Decodificação de tile ============

export interface TileBounds {
	z: number;
	x: number;
	y: number;
}

/** Baixa e decodifica um tile PNG 256x256, devolvendo pixels RGBA. */
export async function fetchTile(
	host: string,
	framePath: string,
	bounds: TileBounds,
): Promise<{ data: Buffer; width: number; height: number }> {
	const url = `${host}${framePath}/256/${bounds.z}/${bounds.x}/${bounds.y}/2/1_1.png`;
	const res = await fetch(url, {
		headers: {
			"User-Agent": "ServicosIpirangaStatus/1.0 (+https://ipiranga.pr.gov.br)",
		},
		signal: AbortSignal.timeout(8_000),
	});
	if (!res.ok) throw new Error(`Tile HTTP ${res.status}: ${url}`);
	const buf = Buffer.from(await res.arrayBuffer());
	const png = PNG.sync.read(buf);
	return { data: png.data, width: png.width, height: png.height };
}

// ============ Análise de frame ============

/**
 * Analisa um tile: classifica cada pixel, agrupa por intensidade e
 * calcula centroides (pixels + geográficos via Web Mercator).
 */
export function analyzeTile(
	pixels: { data: Buffer; width: number; height: number },
	bounds: TileBounds,
): FrameAnalysis {
	const { data, width, height } = pixels;
	const sums = new Map<
		Exclude<RainIntensity, "none">,
		{
			count: number;
			sumDbz: number;
			sumX: number;
			sumY: number;
			maxDbz: number;
		}
	>();
	let maxDbz = -100;
	let precipPixels = 0;

	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const idx = (y * width + x) * 4;
			const r = data[idx];
			const g = data[idx + 1];
			const b = data[idx + 2];
			const a = data[idx + 3];
			const cls = classifyPixel(r, g, b, a);
			if (!cls) continue;
			const intensity = cls.intensity;
			if (intensity === "none") continue;
			precipPixels++;
			if (cls.dbz > maxDbz) maxDbz = cls.dbz;
			let bucket = sums.get(intensity);
			if (!bucket) {
				bucket = { count: 0, sumDbz: 0, sumX: 0, sumY: 0, maxDbz: -100 };
				sums.set(intensity, bucket);
			}
			bucket.count++;
			bucket.sumDbz += cls.dbz;
			bucket.sumX += x;
			bucket.sumY += y;
			if (cls.dbz > bucket.maxDbz) bucket.maxDbz = cls.dbz;
		}
	}

	const cells: RainCell[] = [];
	for (const [intensity, bucket] of sums) {
		const centroidX = bucket.sumX / bucket.count;
		const centroidY = bucket.sumY / bucket.count;
		const { lat, lon } = pixelToLatLon(bounds, centroidX, centroidY);
		cells.push({
			intensity,
			pixelCount: bucket.count,
			maxDbz: bucket.maxDbz,
			meanDbz: bucket.sumDbz / bucket.count,
			centroidX,
			centroidY,
			lat,
			lon,
		});
	}
	// Ordena do mais intenso para o menos intenso
	cells.sort((a, b) => b.maxDbz - a.maxDbz);

	return {
		time: 0, // preenchido pelo caller
		cells,
		maxDbz: maxDbz > -100 ? maxDbz : -100,
		coverage: precipPixels / (width * height),
	};
}

// ============ Web Mercator (pixel → lat/lon) ============

/**
 * Converte pixel (x,y dentro do tile) para lat/lon.
 * Tile slippy map: https://wiki.openstreetmap.org/wiki/Slippy_map_tilenames
 */
export function pixelToLatLon(
	bounds: TileBounds,
	px: number,
	py: number,
): { lat: number; lon: number } {
	const n = 2 ** bounds.z;
	const lonDeg = ((bounds.x + px / 256) / n) * 360 - 180;
	const latRad = Math.atan(
		Math.sinh(Math.PI * (1 - (2 * (bounds.y + py / 256)) / n)),
	);
	const latDeg = (latRad * 180) / Math.PI;
	return { lat: latDeg, lon: lonDeg };
}

// ============ Tracking de movimento ============

/** Distância haversine em km entre duas coordenadas */
export function haversineKm(
	lat1: number,
	lon1: number,
	lat2: number,
	lon2: number,
): number {
	const R = 6371;
	const dLat = ((lat2 - lat1) * Math.PI) / 180;
	const dLon = ((lon2 - lon1) * Math.PI) / 180;
	const a =
		Math.sin(dLat / 2) ** 2 +
		Math.cos((lat1 * Math.PI) / 180) *
			Math.cos((lat2 * Math.PI) / 180) *
			Math.sin(dLon / 2) ** 2;
	return 2 * R * Math.asin(Math.sqrt(a));
}

/**
 * Calcula o vetor de movimento do núcleo mais intenso entre dois frames.
 * Retorna direção (0=N, sentido horário), velocidade km/h e o intervalo.
 */
export function trackMovement(
	from: FrameAnalysis,
	to: FrameAnalysis,
): MovementVector | null {
	const a = from.cells.find((c) => c.intensity !== "light");
	const b = to.cells.find((c) => c.intensity !== "light");
	if (!a || !b) return null;

	// direção: norte = 0°, leste = 90° (sentido horário a partir do norte)
	const dLon = b.lon - a.lon;
	const dLat = b.lat - a.lat;
	const bearingRad = Math.atan2(dLon, dLat); // atan2(E, N)
	const directionDeg = ((bearingRad * 180) / Math.PI + 360) % 360;

	const distKm = haversineKm(a.lat, a.lon, b.lat, b.lon);
	const intervalMin = (to.time - from.time) / 60_000;
	const speedKmh = intervalMin > 0 ? (distKm / intervalMin) * 60 : 0;

	// deslocamento em pixels (para o LLM/UI)
	const dxPx = b.centroidX - a.centroidX;
	const dyPx = b.centroidY - a.centroidY;

	return {
		directionDeg: Math.round(directionDeg),
		speedKmh: Math.round(speedKmh * 10) / 10,
		intervalMin,
		dxPx: Math.round(dxPx),
		dyPx: Math.round(dyPx),
		fromLat: a.lat,
		fromLon: a.lon,
		toLat: b.lat,
		toLon: b.lon,
	};
}

// ============ Orquestração ============

export interface NowcastResult {
	analyzedAt: number;
	frames: FrameAnalysis[];
	/** Vetor de movimento entre o frame mais antigo e o mais recente */
	movement: MovementVector | null;
	/** dBZ máximo observado no frame mais recente */
	currentMaxDbz: number;
	/** Intensidade dominante no frame mais recente */
	currentDominant: RainIntensity;
	/** Núcleo mais intenso (lat/lon) no frame mais recente */
	nearestCell: RainCell | null;
}

/**
 * Pipeline completo: baixa os N frames mais recentes (tiles da região),
 * analisa cada um e calcula o vetor de movimento.
 */
export async function analyzeRadarNowcast(
	host: string,
	pastFrames: RainViewerFrame[],
	bounds: TileBounds,
	frameCount = 3,
): Promise<NowcastResult> {
	// usa os últimos N frames (mais recentes)
	const frames = pastFrames.slice(-frameCount);
	const analyses: FrameAnalysis[] = [];

	for (const frame of frames) {
		try {
			const tile = await fetchTile(host, frame.path, bounds);
			const analysis = analyzeTile(tile, bounds);
			analysis.time = frame.time * 1000;
			analyses.push(analysis);
		} catch (err) {
			logger.warn("Radar nowcast: tile fetch failed", {
				path: frame.path,
				error: String(err),
			});
		}
	}

	if (analyses.length === 0) {
		return {
			analyzedAt: Date.now(),
			frames: [],
			movement: null,
			currentMaxDbz: -100,
			currentDominant: "none",
			nearestCell: null,
		};
	}

	// movimento entre o primeiro e o último frame analisado
	const movement =
		analyses.length >= 2
			? trackMovement(analyses[0], analyses[analyses.length - 1])
			: null;

	const latest = analyses[analyses.length - 1];
	const dominant =
		latest.cells.find((c) => c.intensity !== "light")?.intensity ??
		latest.cells[0]?.intensity ??
		"none";

	return {
		analyzedAt: Date.now(),
		frames: analyses,
		movement,
		currentMaxDbz: latest.maxDbz,
		currentDominant: dominant,
		nearestCell: latest.cells[0] ?? null,
	};
}
