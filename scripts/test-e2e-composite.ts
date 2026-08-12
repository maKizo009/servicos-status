/**
 * Teste E2E local (fora do deploy): roda o pipeline real de nowcast com o
 * radar ao vivo do RainViewer e salva o composite ANOTADO em /tmp para
 * inspeção visual do grounding (pin IPIRANGA + números nos núcleos).
 *
 * Uso: bun run scripts/test-e2e-composite.ts
 */
import { writeFileSync } from "node:fs";
import { REGION_GRID, TARGET_IPIRANGA } from "../src/nowcast-service.js";
import { buildRadarComposite } from "../src/nowcast-vlm.js";
import { analyzeRadarNowcast } from "../src/radar-analysis.js";

// Busca o índice do RainViewer direto (sem Turso/DB — evita 401 local)
const idx = await fetch(
	"https://api.rainviewer.com/public/weather-maps.json",
).then((r) => r.json());
const host = idx.host;
const radar = {
	host,
	radar: { past: idx.radar.past ?? [], nowcast: idx.radar.nowcast ?? [] },
};
console.log("Radar host:", host, "| frames past:", radar.radar.past.length);

const nowcast = await analyzeRadarNowcast(
	radar.host,
	radar.radar.past,
	REGION_GRID,
	3,
	TARGET_IPIRANGA,
);

console.log(
	"dominant:",
	nowcast.currentDominant,
	"| maxDbz:",
	nowcast.currentMaxDbz,
);
console.log("threats:", nowcast.threats.length);
for (const t of nowcast.threats.slice(0, 5)) {
	console.log(
		`  ${t.intensity} @ ${t.distToTargetKm.toFixed(0)}km zone=${t.relevanceZone} approach=${t.threat?.approach ?? "-"} eta=${t.threat?.etaMin ? Math.round(t.threat.etaMin) + "min" : "-"}`,
	);
}
const nearestAlert = nowcast.threats.find((t) => t.relevanceZone === "alert");
const nearestWatch = nowcast.threats.find((t) => t.relevanceZone === "watch");
const alertLevel = nearestAlert ? "alert" : nearestWatch ? "watch" : "monitor";
console.log("ALERT LEVEL RESULTANTE:", alertLevel);

const composite = await buildRadarComposite(
	radar.host,
	radar.radar.past,
	REGION_GRID,
	{
		latestCells: nowcast.threats
			.slice(0, 3)
			.map((t) => ({ lat: t.lat, lon: t.lon, intensity: t.intensity })),
		target: TARGET_IPIRANGA,
	},
);
if (composite) {
	const b64 = composite.dataUrl.replace(/^data:image\/png;base64,/, "");
	writeFileSync("/tmp/composite-anotado.png", Buffer.from(b64, "base64"));
	console.log(
		"Composite salvo em /tmp/composite-anotado.png",
		composite.width,
		"x",
		composite.height,
	);
}
