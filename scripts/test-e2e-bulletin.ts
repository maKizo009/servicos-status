/**
 * Teste E2E Camada B: gera o boletim REAL via Gemini com o composite anotado.
 * Uso: GEMINI_API_KEY=... bun run scripts/test-e2e-bulletin.ts
 */

import { REGION_GRID, TARGET_IPIRANGA } from "../src/nowcast-service.js";
import { generateNowcastBulletin } from "../src/nowcast-vlm.js";
import { analyzeRadarNowcast } from "../src/radar-analysis.js";

const idx = await fetch(
	"https://api.rainviewer.com/public/weather-maps.json",
).then((r) => r.json());
const nowcast = await analyzeRadarNowcast(
	idx.host,
	idx.radar.past ?? [],
	REGION_GRID,
	3,
	TARGET_IPIRANGA,
);
const nearestAlert = nowcast.threats.find((t) => t.relevanceZone === "alert");
const nearestWatch = nowcast.threats.find((t) => t.relevanceZone === "watch");
const alertLevel = nearestAlert ? "alert" : nearestWatch ? "watch" : "monitor";
const nearestThreatKm = nowcast.threats[0]
	? Math.round(nowcast.threats[0].distToTargetKm)
	: null;
console.log("alertLevel:", alertLevel, "| nearestThreatKm:", nearestThreatKm);
console.log(
	"threats:",
	nowcast.threats
		.slice(0, 4)
		.map(
			(t) =>
				`${t.intensity}@${Math.round(t.distToTargetKm)}km(${t.relevanceZone})`,
		)
		.join(", "),
);

const bulletin = await generateNowcastBulletin(
	nowcast,
	idx.host,
	idx.radar.past ?? [],
	REGION_GRID,
	{ rainProbabilityPct: 16, hourlyForecast: [] },
	{ alertLevel, nearestThreatKm },
);
console.log("FONTE:", bulletin.source);
console.log("BOLETIM:", bulletin.text);
