/**
 * Recorte visual + histograma de dBZ do radar em volta de Ipiranga.
 *
 * Complementa verify-anel-radar.ts: além de contar pixels por anel, salva um
 * PNG recortado (o que o olho vê) e a distribuição de dBZ — para separar
 * "chuva real" de "halo claro do tile".
 *
 * Uso: bun run scripts/verify-anel-radar-crop.ts [caminho.png]
 */
import { PNG } from "pngjs";
import {
	classifyPixel,
	haversineKm,
	fetchTileGrid,
	fetchTile,
	normalizeRegion,
	pixelToLatLon,
} from "../src/radar-analysis.js";

const TARGET = { lat: -25.0244, lon: -50.5847 };
const GRID = { z: 7, xMin: 44, yMin: 72, xMax: 47, yMax: 75 } as const;
const TILE_PX = 512;
const OUT = process.argv[2] ?? "/tmp/radar-ipiranga.png";

const res = await fetch("https://api.rainviewer.com/public/weather-maps.json", {
	headers: { "User-Agent": "ServicosIpirangaStatus/1.0 (crop-anel)" },
	signal: AbortSignal.timeout(15_000),
});
const j = (await res.json()) as {
	host: string;
	radar: { past: { time: number; path: string }[] };
};
const frame = j.radar.past[j.radar.past.length - 1];
const norm = normalizeRegion(GRID, TILE_PX);
const { data: rgba, width, height } = await fetchTileGrid(
	j.host,
	frame.path,
	norm,
	TILE_PX,
	false,
);

const hist = new Map<number, number>();
let n80 = 0;
let n120 = 0;
let minKm = Infinity;
let minKmDbz = 0;
for (let y = 0; y < height; y++) {
	for (let x = 0; x < width; x++) {
		const i = (y * width + x) * 4;
		const a = rgba[i + 3] ?? 0;
		if (a < 40) continue;
		const cls = classifyPixel(rgba[i], rgba[i + 1], rgba[i + 2], a);
		if (!cls || cls.intensity === "none") continue;
		const tX = GRID.xMin + Math.floor(x / TILE_PX);
		const tY = GRID.yMin + Math.floor(y / TILE_PX);
		const ll = pixelToLatLon(
			{ z: GRID.z, x: tX, y: tY },
			x % TILE_PX,
			y % TILE_PX,
			TILE_PX,
		);
		const km = haversineKm(ll.lat, ll.lon, TARGET.lat, TARGET.lon);
		if (km < minKm) {
			minKm = km;
			minKmDbz = cls.dbz;
		}
		if (km <= 120) n120++;
		if (km <= 80) {
			n80++;
			hist.set(cls.dbz, (hist.get(cls.dbz) ?? 0) + 1);
		}
	}
}
console.log(`frame ${new Date(frame.time * 1000).toISOString()}`);
console.log(`pixels de chuva ≤80 km: ${n80} | ≤120 km: ${n120}`);
console.log(`pixel de chuva mais PRÓXIMO: ${minKm.toFixed(0)} km (${minKmDbz} dBZ)`);
console.log("histograma de dBZ ≤80 km (dBZ: pixels):");
for (const [dbz, n] of [...hist.entries()].sort((a, b) => a[0] - b[0])) {
	const bar = "█".repeat(Math.min(60, Math.round(n / Math.max(1, n80 / 60))));
	console.log(`  ${String(dbz).padStart(3)} dBZ: ${String(n).padStart(6)} ${bar}`);
}

// ---- recorte visual: tile único z9 em 256 suavizado (o que o mapa mostra) ----
const z = Number(process.env.CROP_Z ?? 8);
const n = 2 ** z;
const lonToX = (lon: number) => Math.floor(((lon + 180) / 360) * n);
const latToY = (lat: number) => {
	const s = Math.sin((lat * Math.PI) / 180);
	return Math.floor((0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n);
};
const px = lonToX(TARGET.lon);
const py = latToY(TARGET.lat);
const out = new PNG({ width: 3 * 256, height: 3 * 256 });
for (let dy = -1; dy <= 1; dy++) {
	for (let dx = -1; dx <= 1; dx++) {
		try {
			const t = await fetchTile(
				j.host,
				frame.path,
				{ z, x: px + dx, y: py + dy },
				256,
				true,
			);
			for (let y = 0; y < 256; y++) {
				for (let x = 0; x < 256; x++) {
					const si = (y * 256 + x) * 4;
					const di = ((y + (dy + 1) * 256) * 768 + (x + (dx + 1) * 256)) * 4;
					out.data[di] = t.data[si] ?? 0;
					out.data[di + 1] = t.data[si + 1] ?? 0;
					out.data[di + 2] = t.data[si + 2] ?? 0;
					out.data[di + 3] = t.data[si + 3] ?? 0;
				}
			}
		} catch (e) {
			console.warn(`tile ${z}/${px + dx}/${py + dy} falhou: ${e}`);
		}
	}
}
const buf = PNG.sync.write(out);
await Bun.write(OUT, buf);
console.log(`recorte salvo em ${OUT} (768x768, ~1,4° — Ipiranga no centro)`);
