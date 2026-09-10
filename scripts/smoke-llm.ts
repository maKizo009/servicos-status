/** Teste live da cadeia LLM com o contexto real de hoje (fora do deploy). */
import { buildAnalystPrompt, tryLlmBulletin } from "../src/llm-bulletin.js";

const ctx = {
	fraseLocal:
		"Chove em Ipiranga agora (2,6 mm na última hora · 29,0 mm em 6h · 45,8 mm em 24h nos pluviômetros da cidade). Condição atual: Chuva Leve.",
	threats: [
		{
			municipio: "Maripá",
			uf: "PR",
			distKm: 329,
			intensity: "heavy",
			approach: "approaching" as const,
			etaMin: 180,
			speedKmh: 136,
		},
	],
	alertLevel: "monitor" as const,
	ecmwfPct: 100,
	ecmwfProx6hMm: 4.2,
	condition: "Chuva Leve",
	hidroWatch: false,
	avisosOficiais: [],
};

console.log("=== PROMPT ===");
console.log(buildAnalystPrompt(ctx));
console.log("=== TENTATIVA ===");
const r = await tryLlmBulletin(
	ctx,
	{
		bearingFromTargetDeg: 0,
		radialKmh: -100,
		approach: "approaching",
		etaMin: 180,
	},
	{ rainProbabilityPct: 100, hourlyForecast: [] },
	{ alertLevel: "monitor", nearestThreatKm: 329 },
);
console.log(r ? `OK [${r.model}]: ${r.text}` : "FALHOU TUDO → heurística");
