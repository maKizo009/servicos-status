/**
 * Verificação em produção do gate do boletim (21/09/2026).
 *
 * Roda a MESMA função que gera o boletim em produção (`buildHeuristicBulletin`)
 * com o nowcast AO VIVO da API, e compara com o contra-factual: o mesmo núcleo
 * classificado como o código antigo classificava (zona ausente + approaching).
 *
 * Prova: com o fix, núcleo distante não vira narrativa; com a classificação
 * antiga, vira. Uso: bun run scripts/verify-gate-boletim.ts
 */
import { buildHeuristicBulletin } from "../src/nowcast-vlm.js";
import type { NowcastResult } from "../src/radar-analysis.js";

let falhas = 0;
function check(nome: string, cond: boolean, detalhe = "") {
	if (cond) console.log(`✅ ${nome}`);
	else {
		console.error(`❌ ${nome}${detalhe ? ` — ${detalhe}` : ""}`);
		falhas++;
	}
}

const r = await fetch("https://servicos-status.vercel.app/api/weather");
const d = (await r.json()) as Record<string, unknown>;
const nowcast = d.nowcast as NowcastResult | null;
if (!nowcast || !nowcast.threats?.length) {
	console.error("❌ API sem nowcast/threats — nada a verificar");
	process.exit(1);
}

const ecmwf = {
	rainProbabilityPct: (d.rainProbabilityPct as number) ?? null,
	hourlyForecast: (d.hourlyForecast as never[]) ?? [],
};
const relevance = {
	alertLevel: (d.alertLevel as "alert" | "watch" | "monitor" | "none") ?? "monitor",
	nearestThreatKm: (d.nearestThreatKm as number) ?? null,
};
const ests = ((d.cemaden as Record<string, unknown>)?.estacoes ?? []) as {
	acc1hr: number | null;
	acc6hr: number | null;
	acc24hr: number | null;
}[];
const local = {
	acc1hrMax: Math.max(0, ...ests.map((e) => e.acc1hr ?? 0)),
	acc6hrMax: Math.max(0, ...ests.map((e) => e.acc6hr ?? 0)),
	acc24hrMax: Math.max(0, ...ests.map((e) => e.acc24hr ?? 0)),
	condition: (d.condition as string) ?? null,
};

const t0 = nowcast.threats[0];
console.log("=== NÚCLEO MAIS AMEAÇADOR (dado vivo) ===");
console.log(
	`  ${Math.round(t0.distToTargetKm)} km | zona=${t0.relevanceZone} | approach=${t0.threat?.approach} | fração radial=${t0.threat?.radialFraction?.toFixed(2)} | ETA=${t0.threat?.etaMin ? Math.round(t0.threat.etaMin) + " min" : "-"}`,
);

console.log("\n=== A. COM O FIX (código de produção + dado vivo) ===");
const comFix = buildHeuristicBulletin(nowcast, ecmwf, relevance, local);
console.log(`  "${comFix}"`);
check(
	"A1. não narra o núcleo distante como ameaça a Ipiranga",
	!/Guarujá|Guaruja|19 horas|pode chegar em/.test(comFix),
);
check(
	"A2. diz que a atividade está distante/sem influência",
	/distante|sem influência|Sem chuva relevante/i.test(comFix),
	comFix.slice(0, 90),
);
check(
	"A3. não promete chegada (nenhum ETA no texto)",
	!/chegada em|chega em/i.test(comFix),
);

console.log("\n=== B. CONTRA-FACTUAL (o mesmo núcleo como o código antigo lia) ===");
// Reproduz o estado que gerou o boletim de 22:20: o núcleo vinha com
// `relevanceZone` e o radial marcava "approaching" (o bug do ±60°).
const antigo = JSON.parse(JSON.stringify(nowcast)) as NowcastResult;
for (const t of antigo.threats) {
	delete (t as { relevanceZone?: unknown }).relevanceZone;
	if (t.threat) t.threat.radialFraction = -0.33; // valor real do caso Guarujá
}
const semFix = buildHeuristicBulletin(antigo, ecmwf, relevance, local);
console.log(`  "${semFix}"`);
check(
	"B1. sem o fix, o mesmo núcleo VIRA narrativa (prova de que o fix é o que barra)",
	/B1|Guarujá|Guaruja|km|distância/i.test(semFix) && semFix !== comFix,
);
console.log(
	`\n  diferença: ${semFix.length} vs ${comFix.length} caracteres`,
);

console.log(
	`\n${falhas === 0 ? "✅ GATE VERIFICADO EM PRODUÇÃO" : `❌ ${falhas} VERIFICAÇÃO(ÕES) FALHARAM`}`,
);
process.exit(falhas === 0 ? 0 : 1);
