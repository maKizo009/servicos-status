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
	/** Vetor de movimento INDIVIDUAL do núcleo (associado entre frames), se houver */
	trackedMovement?: MovementVector | null;
}

/**
 * Núcleo avaliado contra um alvo (ex.: Ipiranga). Cada núcleo forte/extremo
 * recebe seu próprio veredicto — o sistema NÃO se limita ao mais intenso.
 */
export interface ThreatCell extends RainCell {
	/** Distância haversine do núcleo até o alvo (km) */
	distToTargetKm: number;
	/** Movimento individual do núcleo (pode ser null se não associável) */
	movement: MovementVector | null;
	/** Veredicto de ameaça determinístico (null se sem movimento confiável) */
	threat: ThreatVerdict | null;
	/**
	 * Zona de relevância para o alvo (gates de distância/ETA — Camada A).
	 * alert = iminente (≤80 km, ETA ≤120 min) | watch = vigilância
	 * (≤200 km, ETA ≤360 min) | monitor = longe/afastando/estacionário.
	 * Núcleo extreme a <50 km SEMPRE é alert (fallback de falso negativo:
	 * célula que surge perto e se intensifica rápido, mesmo sem tracking).
	 */
	relevanceZone: "alert" | "watch" | "monitor";
}

/**
 * Zonas de relevância (raios e ETAs máximos). Configuráveis aqui —
 * valores baseados no incidente real 2026-08-12 (núcleo a 336 km/ETA 488 min
 * NÃO deve acender alerta).
 */
export const RELEVANCE_ZONES = {
	/** Iminente: ≤80 km e ETA ≤120 min → "Alerta" (card COPEL ativo) */
	alert: { maxKm: 80, maxEtaMin: 120 },
	/** Vigilância: ≤200 km e ETA ≤360 min → "Vigilância" (sem card de alerta) */
	watch: { maxKm: 200, maxEtaMin: 360 },
	/** Núcleo extreme dentro deste raio SEMPRE gera alerta (fallback segurança) */
	extremeFallbackKm: 50,
} as const;

/**
 * Classifica a zona de relevância de um núcleo em relação ao alvo.
 * Regras (proporcionais ao perigo real, não à intensidade bruta):
 *  - approaching + ETA ≤ 120 min + dist ≤ 80 km → alert
 *  - approaching + ETA ≤ 360 min + dist ≤ 200 km → watch
 *  - extreme a <50 km → alert mesmo sem movimento confiável
 *  - crossing/receding/estacionário/longe → monitor (sem risco iminente)
 */
export function classifyRelevanceZone(
	distKm: number,
	approach: ThreatVerdict["approach"] | null,
	etaMin: number | null,
	intensity: RainCell["intensity"],
	speedKmh: number | null,
): "alert" | "watch" | "monitor" {
	// Movimento confiável MEDIDO entre frames (>2 km/h com veredito) manda:
	// receding/crossing nunca é alerta, mesmo extreme a 30 km (está indo
	// embora). approaching usa as zonas de distância/ETA.
	const hasReliableMovement =
		speedKmh != null && speedKmh > 2 && approach != null;
	if (hasReliableMovement) {
		if (approach === "approaching" && etaMin != null) {
			if (
				distKm <= RELEVANCE_ZONES.alert.maxKm &&
				etaMin <= RELEVANCE_ZONES.alert.maxEtaMin
			) {
				return "alert";
			}
			if (
				distKm <= RELEVANCE_ZONES.watch.maxKm &&
				etaMin <= RELEVANCE_ZONES.watch.maxEtaMin
			) {
				return "watch";
			}
		}
		return "monitor";
	}
	// Fallback de segurança (SEM movimento confiável): núcleo extreme MUITO
	// perto pode ter surgido e se intensificado entre frames sem tracking —
	// alerta preventivo, não espera o ETA.
	if (distKm <= RELEVANCE_ZONES.extremeFallbackKm && intensity === "extreme") {
		return "alert";
	}
	return "monitor";
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

/** Grid retangular de tiles no mesmo zoom (ex.: 4x4 de z=9 = área de 1 tile z=7). */
export interface TileGrid {
	z: number;
	xMin: number;
	yMin: number;
	xMax: number;
	yMax: number;
}

export type RegionSpec = TileBounds | TileGrid;

export interface NormalizedRegion {
	grid: TileGrid;
	/** Tile "pai" usado na conversão pixel→lat/lon (zoom do pai = z - log2(gridSize)) */
	parent: TileBounds;
	/** Lado do grid em tiles (1 para tile único, 4 para 4x4) */
	gridSize: number;
	width: number;
	height: number;
}

/** Normaliza RegionSpec (tile único ou grid) para um mosaico analisável. */
export function normalizeRegion(spec: RegionSpec): NormalizedRegion {
	if ("xMax" in spec) {
		const grid = spec as TileGrid;
		const gw = grid.xMax - grid.xMin + 1;
		const gh = grid.yMax - grid.yMin + 1;
		const gridSize = Math.max(gw, gh);
		const log2 = Math.round(Math.log2(gridSize));
		return {
			grid,
			parent: {
				z: grid.z - log2,
				x: Math.floor(grid.xMin / gridSize),
				y: Math.floor(grid.yMin / gridSize),
			},
			gridSize,
			width: gw * 256,
			height: gh * 256,
		};
	}
	const b = spec as TileBounds;
	return {
		grid: { z: b.z, xMin: b.x, yMin: b.y, xMax: b.x, yMax: b.y },
		parent: b,
		gridSize: 1,
		width: 256,
		height: 256,
	};
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

/**
 * Baixa todos os tiles de um grid (mosaico) para um frame e monta
 * uma única imagem RGBA. Falhas de tiles individuais são toleradas
 * (o tile fica transparente) para não derrubar o frame inteiro.
 */
export async function fetchTileGrid(
	host: string,
	framePath: string,
	norm: NormalizedRegion,
): Promise<{ data: Buffer; width: number; height: number }> {
	const { grid, width, height } = norm;
	const composite = new PNG({ width, height });

	const tasks: Promise<void>[] = [];
	for (let ty = grid.yMin; ty <= grid.yMax; ty++) {
		for (let tx = grid.xMin; tx <= grid.xMax; tx++) {
			tasks.push(
				(async () => {
					try {
						const tile = await fetchTile(host, framePath, {
							z: grid.z,
							x: tx,
							y: ty,
						});
						const dstX = (tx - grid.xMin) * 256;
						const dstY = (ty - grid.yMin) * 256;
						for (let y = 0; y < 256; y++) {
							for (let x = 0; x < 256; x++) {
								const si = (y * 256 + x) * 4;
								const di = ((dstY + y) * width + (dstX + x)) * 4;
								composite.data[di] = tile.data[si];
								composite.data[di + 1] = tile.data[si + 1];
								composite.data[di + 2] = tile.data[si + 2];
								composite.data[di + 3] = tile.data[si + 3];
							}
						}
					} catch (err) {
						logger.warn("TileGrid: tile falhou (mantido vazio)", {
							tile: `${grid.z}/${tx}/${ty}`,
							error: String(err),
						});
					}
				})(),
			);
		}
	}
	await Promise.all(tasks);
	return { data: composite.data, width, height };
}

// ============ Análise de frame ============

/** Área mínima (px) para um componente ser considerado núcleo (descarta ruído). */
const MIN_CELL_PIXELS = 8;

/** Vizinhança 8 (inclui diagonais) para unir pixels do mesmo núcleo. */
const NEIGHBORS: ReadonlyArray<readonly [number, number]> = [
	[-1, -1],
	[0, -1],
	[1, -1],
	[-1, 0],
	[1, 0],
	[-1, 1],
	[0, 1],
	[1, 1],
];

/**
 * Analisa um tile/mosaico: SEGMENTA núcleos por componentes conexas
 * (flood-fill em pixels >= moderate) em vez de agrupar por nível de
 * intensidade. Cada núcleo geográfico separado vira uma RainCell com
 * centroide próprio — dois núcleos fortes distantes NÃO viram um
 * centroide médio (bug anterior que mascarava núcleos ameaçadores).
 *
 * Chuva leve (< moderate) é tratada como fundo: não vira núcleo próprio
 * (evita um "mar" de chuva fraca conectando tudo), mas conta na coverage.
 */
export function analyzeTile(
	pixels: { data: Buffer; width: number; height: number },
	bounds: TileBounds,
	gridSize = 1,
): FrameAnalysis {
	const { data, width, height } = pixels;
	const n = width * height;

	// Classifica todos os pixels uma única vez (dBZ por pixel; -999 = sem dado)
	const dbzGrid = new Int16Array(n).fill(-999);
	let maxDbz = -100;
	let precipPixels = 0;
	for (let i = 0; i < n; i++) {
		const idx = i * 4;
		const cls = classifyPixel(
			data[idx],
			data[idx + 1],
			data[idx + 2],
			data[idx + 3],
		);
		if (!cls || cls.intensity === "none") continue;
		dbzGrid[i] = Math.round(cls.dbz);
		precipPixels++;
		if (cls.dbz > maxDbz) maxDbz = cls.dbz;
	}

	// Flood-fill (BFS) sobre pixels >= moderate → componentes conexos
	const visited = new Uint8Array(n);
	const cells: RainCell[] = [];
	const queue: number[] = [];

	for (let start = 0; start < n; start++) {
		if (visited[start] || dbzGrid[start] < INTENSITY_THRESHOLDS.moderate) {
			continue;
		}
		// BFS a partir de `start`
		visited[start] = 1;
		queue.length = 0;
		queue.push(start);
		let count = 0;
		let sumDbz = 0;
		let sumX = 0;
		let sumY = 0;
		let cellMaxDbz = -100;
		while (queue.length > 0) {
			const p = queue.pop();
			if (p === undefined) break;
			const px = p % width;
			const py = (p / width) | 0;
			const dbz = dbzGrid[p];
			count++;
			sumDbz += dbz;
			sumX += px;
			sumY += py;
			if (dbz > cellMaxDbz) cellMaxDbz = dbz;
			for (const [dx, dy] of NEIGHBORS) {
				const nx = px + dx;
				const ny = py + dy;
				if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
				const np = ny * width + nx;
				if (visited[np] || dbzGrid[np] < INTENSITY_THRESHOLDS.moderate) {
					continue;
				}
				visited[np] = 1;
				queue.push(np);
			}
		}
		if (count < MIN_CELL_PIXELS) continue;
		const centroidX = sumX / count;
		const centroidY = sumY / count;
		const { lat, lon } = pixelToLatLon(
			bounds,
			centroidX / gridSize,
			centroidY / gridSize,
		);
		// Componente só contém pixels >= moderate (20 dBZ) → nunca "none"
		const intensity = intensityFromDbz(cellMaxDbz) as Exclude<
			RainIntensity,
			"none"
		>;
		cells.push({
			intensity,
			pixelCount: count,
			maxDbz: cellMaxDbz,
			meanDbz: sumDbz / count,
			centroidX,
			centroidY,
			lat,
			lon,
		});
	}

	// Ordena do mais intenso para o menos intenso (mantém cells[0] = mais intenso)
	cells.sort((a, b) => b.maxDbz - a.maxDbz);

	return {
		time: 0, // preenchido pelo caller
		cells,
		maxDbz: maxDbz > -100 ? maxDbz : -100,
		coverage: precipPixels / n,
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

// ============ Análise de ameaça (aproximação/afastamento) ============

/** Ponto de destino após percorrer distKm a partir de lat/lon no bearing (0=N). */
export function destinationPoint(
	lat: number,
	lon: number,
	bearingDeg: number,
	distKm: number,
): { lat: number; lon: number } {
	const R = 6371;
	const brg = (bearingDeg * Math.PI) / 180;
	const d = distKm / R;
	const lat1 = (lat * Math.PI) / 180;
	const lon1 = (lon * Math.PI) / 180;
	const lat2 = Math.asin(
		Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(brg),
	);
	const lon2 =
		lon1 +
		Math.atan2(
			Math.sin(brg) * Math.sin(d) * Math.cos(lat1),
			Math.cos(d) - Math.sin(lat1) * Math.sin(lat2),
		);
	return {
		lat: (lat2 * 180) / Math.PI,
		lon: (((lon2 * 180) / Math.PI + 540) % 360) - 180,
	};
}

/**
 * Veredicto de ameaça de um núcleo em movimento em relação a um alvo.
 *
 * Calcula a componente radial da velocidade do núcleo na direção do alvo:
 *   - approaching: a distância núcleo→alvo está DIMINUINDO (vem em direção)
 *   - receding: a distância está AUMENTANDO (está indo embora)
 *   - crossing: trajetória tangencial (passa de raspão, sem aproximar)
 *
 * Isto é a Camada A: o VLM NUNCA decide isso, apenas narra o veredicto.
 */
export interface ThreatVerdict {
	/** Bearing do núcleo visto do alvo (0=N, 90=L) */
	bearingFromTargetDeg: number;
	/** Componente radial da velocidade: <0 aproximando, >0 afastando (km/h) */
	radialKmh: number;
	approach: "approaching" | "receding" | "crossing";
	/** ETA em minutos se approaching, senão null */
	etaMin: number | null;
}

export function assessThreat(
	cellLat: number,
	cellLon: number,
	movement: { directionDeg: number; speedKmh: number },
	targetLat: number,
	targetLon: number,
): ThreatVerdict {
	// Bearing do alvo → núcleo (direção em que o núcleo está, vista do alvo)
	const dLat = ((cellLat - targetLat) * Math.PI) / 180;
	const dLon = ((cellLon - targetLon) * Math.PI) / 180;
	const lat1 = (targetLat * Math.PI) / 180;
	const lat2 = (cellLat * Math.PI) / 180;
	const y = Math.sin(dLon) * Math.cos(lat2);
	const x =
		Math.cos(lat1) * Math.sin(lat2) -
		Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
	const bearingFromTargetDeg = ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;

	// Componente da velocidade do núcleo na direção do alvo.
	// cos(ângulo entre movimento e bearing) → +1 = na direção do alvo,
	// -1 = na direção oposta. Multiplicando pela velocidade:
	//   negativo = aproximando do alvo, positivo = afastando.
	const deltaDeg = movement.directionDeg - bearingFromTargetDeg;
	const radialKmh = movement.speedKmh * Math.cos((deltaDeg * Math.PI) / 180);

	const distKm = haversineKm(cellLat, cellLon, targetLat, targetLon);
	let approach: ThreatVerdict["approach"] = "crossing";
	if (radialKmh < -2) approach = "approaching";
	else if (radialKmh > 2) approach = "receding";

	const etaMin =
		approach === "approaching" && Math.abs(radialKmh) > 1
			? (distKm / Math.abs(radialKmh)) * 60
			: null;

	return { bearingFromTargetDeg, radialKmh, approach, etaMin };
}

/** Projeção da posição do núcleo em t minutos (extrapolação linear). */
export function projectCell(
	lat: number,
	lon: number,
	movement: { directionDeg: number; speedKmh: number },
	minutes: number,
): { lat: number; lon: number } {
	return destinationPoint(
		lat,
		lon,
		movement.directionDeg,
		(movement.speedKmh * minutes) / 60,
	);
}

/**
 * Associa núcleos entre dois frames por proximidade geográfica e calcula
 * o vetor de movimento INDIVIDUAL de cada núcleo do frame mais novo.
 * Núcleo sem par próximo (ou velocidade implausível) fica com null.
 */
export function associateMovements(
	older: FrameAnalysis,
	newer: FrameAnalysis,
	maxAssocKm = 80,
): void {
	for (const cell of newer.cells) {
		let best: RainCell | null = null;
		let bestDist = Infinity;
		for (const oc of older.cells) {
			const d = haversineKm(cell.lat, cell.lon, oc.lat, oc.lon);
			if (d < bestDist) {
				bestDist = d;
				best = oc;
			}
		}
		if (!best || bestDist > maxAssocKm) {
			cell.trackedMovement = null;
			continue;
		}
		const dLon = cell.lon - best.lon;
		const dLat = cell.lat - best.lat;
		const bearingRad = Math.atan2(dLon, dLat); // atan2(E, N)
		const directionDeg = ((bearingRad * 180) / Math.PI + 360) % 360;
		const intervalMin = (newer.time - older.time) / 60_000;
		const speedKmh = intervalMin > 0 ? (bestDist / intervalMin) * 60 : 0;
		// Velocidade implausível (>150 km/h): associação espúria (núcleo
		// dissipou e outro surgiu perto). Não confiável → sem movimento.
		if (speedKmh > 150) {
			cell.trackedMovement = null;
			continue;
		}
		cell.trackedMovement = {
			directionDeg: Math.round(directionDeg),
			speedKmh: Math.round(speedKmh * 10) / 10,
			intervalMin,
			dxPx: Math.round(cell.centroidX - best.centroidX),
			dyPx: Math.round(cell.centroidY - best.centroidY),
			fromLat: best.lat,
			fromLon: best.lon,
			toLat: cell.lat,
			toLon: cell.lon,
		};
	}
}

/**
 * Avalia TODOS os núcleos fortes/extremos contra um alvo (ex.: Ipiranga).
 * Cada núcleo recebe distância + veredicto de ameaça com seu movimento
 * individual. Ordena por perigo: aproximando (menor ETA) → mais próximo.
 */
export function assessAllThreats(
	cells: RainCell[],
	targetLat: number,
	targetLon: number,
): ThreatCell[] {
	return cells
		.filter((c) => c.intensity === "heavy" || c.intensity === "extreme")
		.map((c) => {
			const movement = c.trackedMovement ?? null;
			const threat = movement
				? assessThreat(c.lat, c.lon, movement, targetLat, targetLon)
				: null;
			const distToTargetKm = haversineKm(c.lat, c.lon, targetLat, targetLon);
			return {
				...c,
				distToTargetKm,
				movement,
				threat,
				// Gate de relevância (distância + ETA + direção): define se o
				// núcleo é iminente, vigilância ou apenas monitoramento.
				relevanceZone: classifyRelevanceZone(
					distToTargetKm,
					threat?.approach ?? null,
					threat?.etaMin ?? null,
					c.intensity,
					movement?.speedKmh ?? null,
				),
			};
		})
		.sort((a, b) => {
			const pa = a.threat?.approach === "approaching" ? 0 : 1;
			const pb = b.threat?.approach === "approaching" ? 0 : 1;
			if (pa !== pb) return pa - pb;
			if (
				a.threat?.approach === "approaching" &&
				b.threat?.approach === "approaching"
			) {
				return (a.threat.etaMin ?? Infinity) - (b.threat.etaMin ?? Infinity);
			}
			return a.distToTargetKm - b.distToTargetKm;
		});
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
	/** TODOS os núcleos fortes/extremos avaliados contra Ipiranga (ordenados por perigo) */
	threats: ThreatCell[];
	/** Mensagem de erro em caso de falha */
	error?: string;
}

/**
 * Pipeline completo: baixa os N frames mais recentes (tiles da região),
 * analisa cada um (segmentação por componentes conexas), associa núcleos
 * entre frames (movimento individual) e avalia todos os núcleos fortes
 * contra o alvo. `target` opcional (lat/lon de Ipiranga); sem ele,
 * threats = [].
 */
export async function analyzeRadarNowcast(
	host: string,
	pastFrames: RainViewerFrame[],
	region: RegionSpec,
	frameCount = 3,
	target?: { lat: number; lon: number },
): Promise<NowcastResult> {
	// usa os últimos N frames (mais recentes)
	const frames = pastFrames.slice(-frameCount);
	const norm = normalizeRegion(region);
	const analyses: FrameAnalysis[] = [];

	for (const frame of frames) {
		try {
			const mosaic = await fetchTileGrid(host, frame.path, norm);
			const analysis = analyzeTile(mosaic, norm.parent, norm.gridSize);
			analysis.time = frame.time * 1000;
			analyses.push(analysis);
		} catch (err) {
			logger.warn("Radar nowcast: mosaico do frame falhou", {
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
			threats: [],
		};
	}

	// Associa núcleos entre frames CONSECUTIVOS → movimento individual por núcleo
	for (let i = 1; i < analyses.length; i++) {
		associateMovements(analyses[i - 1], analyses[i]);
	}

	// Movimento global: o do núcleo mais intenso do último frame (retrocompatível)
	const latest = analyses[analyses.length - 1];
	const globalMovement =
		latest.cells.find((c) => c.trackedMovement)?.trackedMovement ?? null;

	const dominant =
		latest.cells.find((c) => c.intensity !== "light")?.intensity ??
		latest.cells[0]?.intensity ??
		"none";

	// Avalia TODOS os núcleos fortes/extremos contra o alvo
	const threats =
		target && latest.cells.length > 0
			? assessAllThreats(latest.cells, target.lat, target.lon)
			: [];

	return {
		analyzedAt: Date.now(),
		frames: analyses,
		movement: globalMovement,
		currentMaxDbz: latest.maxDbz,
		currentDominant: dominant,
		nearestCell: latest.cells[0] ?? null,
		threats,
	};
}
