/**
 * Verificador do ANEL de chuva em volta de Ipiranga (21/09/2026).
 *
 * Por que existe: o alerta de chuva só considera núcleos heavy (≥38 dBZ) ou
 * extreme (≥48 dBZ) — áreas de chuva MODERADA (20–37 dBZ) são descartadas
 * antes de qualquer gate. Quando uma área moderada grande está vindo (caso
 * real 21/09 19:30: 4.504 px a 113 km, chegando em ~69 min), o site diz
 * "nenhum núcleo por perto" e nenhum alerta sai.
 *
 * Este script mede, com o MESMO decodificador do backend, quanto de chuva
 * existe em cada anel de distância em volta do alvo — separando por
 * intensidade — para separar "radar vazio" de "chuva invisível pro gate".
 *
 * Uso: bun run scripts/verify-anel-radar.ts
 */
import {
	classifyPixel,
	haversineKm,
	fetchTileGrid,
	normalizeRegion,
	pixelToLatLon,
	INTENSITY_THRESHOLDS,
	type NormalizedRegion,
	type RainIntensity,
} from "../src/radar-analysis.js";

const TARGET = { lat: -25.0244, lon: -50.5847 };
const GRID = { z: 7, xMin: 44, yMin: 72, xMax: 47, yMax: 75 } as const;
const TILE_PX = 512;
const RINGS_KM = [25, 50, 80, 120, 200, 300];

async function main() {
	const res = await fetch("https://api.rainviewer.com/public/weather-maps.json", {
		headers: { "User-Agent": "ServicosIpirangaStatus/1.0 (verificador-anel)" },
		signal: AbortSignal.timeout(15_000),
	});
	if (!res.ok) throw new Error(`RainViewer HTTP ${res.status}`);
	const data = (await res.json()) as {
		host: string;
		radar: { past: { time: number; path: string }[] };
	};
	const frames = data.radar.past.slice(-3);
	console.log(`host=${data.host} frames=${frames.length}`);

	const norm: NormalizedRegion = normalizeRegion(GRID, TILE_PX);

	for (const frame of frames) {
		const px = await fetchTileGrid(data.host, frame.path, norm, TILE_PX, false);
		const { data: rgba, width, height } = px;

		// anel -> contagem por intensidade
		const buckets = new Map<number, Record<RainIntensity, number>>();
		for (const r of RINGS_KM) {
			buckets.set(r, {
				none: 0,
				light: 0,
				moderate: 0,
				heavy: 0,
				extreme: 0,
			});
		}
		let maxDbz = -100;
		let maxDbzKm: number | null = null;

		for (let y = 0; y < height; y++) {
			for (let x = 0; x < width; x++) {
				const i = (y * width + x) * 4;
				const cls = classifyPixel(
					rgba[i],
					rgba[i + 1],
					rgba[i + 2],
					rgba[i + 3],
				);
				if (!cls || cls.intensity === "none") continue;
				// pixel -> lat/lon dentro do mosaico (grid 4x4 → parent z5)
				const tileX = GRID.xMin + Math.floor(x / TILE_PX);
				const tileY = GRID.yMin + Math.floor(y / TILE_PX);
				const { lat, lon } = pixelToLatLon(
					{ z: GRID.z, x: tileX, y: tileY },
					x % TILE_PX,
					y % TILE_PX,
					TILE_PX,
				);
				const km = haversineKm(lat, lon, TARGET.lat, TARGET.lon);
				if (cls.dbz > maxDbz) {
					maxDbz = cls.dbz;
					maxDbzKm = km;
				}
				for (const r of RINGS_KM) {
					if (km <= r) {
						const b = buckets.get(r);
						if (b) b[cls.intensity]++;
					}
				}
			}
		}

		const hora = new Date(frame.time * 1000).toISOString().slice(11, 16);
		console.log(`\n=== frame ${hora}Z ===`);
		console.log(
			`dBZ máximo global: ${maxDbz}${maxDbzKm != null ? ` (a ${maxDbzKm.toFixed(0)} km)` : ""} | limiares: light≥${INTENSITY_THRESHOLDS.light} moderate≥${INTENSITY_THRESHOLDS.moderate} heavy≥${INTENSITY_THRESHOLDS.heavy} extreme≥${INTENSITY_THRESHOLDS.extreme}`,
		);
		for (const r of RINGS_KM) {
			const b = buckets.get(r);
			if (!b) continue;
			const total = b.light + b.moderate + b.heavy + b.extreme;
			console.log(
				`  ≤${String(r).padStart(3)} km: total=${String(total).padStart(7)} px | light=${String(b.light).padStart(6)} moderate=${String(b.moderate).padStart(6)} heavy=${String(b.heavy).padStart(6)} extreme=${String(b.extreme).padStart(6)}`,
			);
		}
		// O que o gate de alerta ENXERGA hoje (heavy+extreme):
		const r80 = buckets.get(80);
		const r200 = buckets.get(200);
		console.log(
			`  >> gate atual (heavy/extreme): ≤80 km = ${(r80?.heavy ?? 0) + (r80?.extreme ?? 0)} px | ≤200 km = ${(r200?.heavy ?? 0) + (r200?.extreme ?? 0)} px`,
		);
		console.log(
			`  >> invisível pro gate (light/moderate): ≤80 km = ${(r80?.light ?? 0) + (r80?.moderate ?? 0)} px | ≤200 km = ${(r200?.light ?? 0) + (r200?.moderate ?? 0)} px`,
		);
	}
}

main().catch((e) => {
	console.error("falhou:", e);
	process.exit(1);
});
