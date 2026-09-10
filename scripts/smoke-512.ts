/** Smoke E2E (fora do deploy): tiles 512/0_1 reais + comparação 256 vs 512. */

import { REGION_GRID, TARGET_IPIRANGA } from "../src/nowcast-service.js";
import { analyzeRadarNowcast } from "../src/radar-analysis.js";

const idx = (await (
	await fetch("https://api.rainviewer.com/public/weather-maps.json", {
		headers: { "User-Agent": "ServicosIpirangaStatus/1.0" },
	})
).json()) as {
	host: string;
	radar: { past: { time: number; path: string }[] };
};

for (const [tileSize, smooth] of [
	[256, true],
	[512, false],
] as const) {
	const t0 = Date.now();
	const r = await analyzeRadarNowcast(
		idx.host,
		idx.radar.past,
		REGION_GRID,
		3,
		TARGET_IPIRANGA,
		tileSize,
		smooth,
	);
	const dt = ((Date.now() - t0) / 1000).toFixed(1);
	const cells = r.frames.at(-1)?.cells.length ?? -1;
	console.log(
		`tile=${tileSize} smooth=${smooth} tempo=${dt}s frames=${r.frames.length} ` +
			`cells=${cells} threats=${r.threats.length} maxDbz=${r.currentMaxDbz} ` +
			`dom=${r.currentDominant} mov=${r.movement ? `${r.movement.directionDeg}°/${r.movement.speedKmh}km/h` : "null"}`,
	);
	for (const t of r.threats.slice(0, 3))
		console.log(
			`  threat ${t.intensity} px=${t.pixelCount} dist=${t.distToTargetKm.toFixed(0)}km zone=${t.relevanceZone}`,
		);
}
