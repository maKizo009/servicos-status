/**
 * Verificação da correção "ÁREA DE CHUVA" (21/09/2026) com dado AO VIVO.
 *
 * Roda o código NOVO (assessAllThreats + classifyRelevanceZone deste repo) sobre
 * CÉLULAS REAIS de payloads do /api/weather e compara com o que o sistema
 * reportou ANTES do fix (o campo nowcast.threats do próprio payload).
 *
 * Racional: o gate antigo só aceitava núcleo heavy/extreme (≥12 px @256). Chuva
 * contínua moderada (20–37 dBZ) em área grande, chegando, era invisível —
 * aparece no print do Dave (19:30 BRT): área de 4.504 px a 113 km com ETA ~1h20
 * enquanto o boletim dizia "nenhum núcleo por perto".
 *
 * Uso: bun run scripts/verify-area-chuva.ts <payload.json> [<payload.json> ...]
 *      (sem argumento: baixa o payload atual de produção)
 */
import {
	assessAllThreats,
	type RainCell,
	type ThreatCell,
} from "../src/radar-analysis.js";

const IPIRANGA = { lat: -25.0244, lon: -50.5847 };
const TILE = 512; // resolução usada em produção (mosaico 512, scheme 2)

let falhas = 0;
function check(nome: string, cond: boolean, detalhe = "") {
	if (cond) console.log(`✅ ${nome}`);
	else {
		console.error(`❌ ${nome}${detalhe ? ` — ${detalhe}` : ""}`);
		falhas++;
	}
}

function resumo(t: ThreatCell) {
	return `${t.intensity} ${Math.round(t.distToTargetKm)}km px=${t.pixelCount} maxDbz=${t.maxDbz} kind=${t.kind} approach=${t.threat?.approach ?? "sem vetor"}${t.threat?.etaMin ? ` ETA=${Math.round(t.threat.etaMin)}min` : ""} zona=${t.relevanceZone}`;
}

const argumentos = process.argv.slice(2);
const fontes: { rotulo: string; dados: Record<string, unknown> }[] = [];
for (const a of argumentos) {
	fontes.push({ rotulo: a, dados: JSON.parse(await Bun.file(a).text()) });
}
if (fontes.length === 0) {
	const r = await fetch("https://servicos-status.vercel.app/api/weather");
	fontes.push({ rotulo: "produção AGORA", dados: (await r.json()) as never });
}

for (const { rotulo, dados } of fontes) {
	const nc = dados.nowcast as {
		frames?: { cells?: RainCell[] }[];
		threats?: ThreatCell[];
		tileSize?: number;
	} | null;
	const celulas = nc?.frames?.at(-1)?.cells ?? [];
	console.log(
		`\n================= ${rotulo} — ${celulas.length} células no último frame =================`,
	);
	if (celulas.length === 0) {
		console.log("  (sem células — payload sem nowcast? ignorado)");
		continue;
	}

	// O QUE O SISTEMA (ANTES DO FIX) REPORTou — direto do payload de produção.
	const antes = (nc?.threats ?? []).slice(0, 5);
	const antesPerto = antes.filter((t) => t.relevanceZone !== "monitor");
	console.log(
		`ANTES (payload de produção): alertLevel=${dados.alertLevel} nearestThreatKm=${dados.nearestThreatKm} | entidades fora de monitor: ${antesPerto.length}`,
	);
	for (const t of antes) console.log(`   · ${resumo(t)}`);
	console.log(`   regionalRainAlert: ${dados.regionalRainAlert ?? "(vazio)"}`);

	// O QUE O SISTEMA (DEPOIS DO FIX) VÊ — mesmo código, células reais.
	const depois = assessAllThreats(
		celulas,
		IPIRANGA.lat,
		IPIRANGA.lon,
		TILE,
	);
	const depoisPerto = depois.filter((t) => t.relevanceZone !== "monitor");
	console.log(
		`DEPOIS (código novo): ${depois.length} entidades avaliadas | fora de monitor: ${depoisPerto.length} | alert=${depoisPerto.filter((t) => t.relevanceZone === "alert").length} watch=${depoisPerto.filter((t) => t.relevanceZone === "watch").length}`,
	);
	for (const t of depoisPerto.slice(0, 6)) console.log(`   ⭐ ${resumo(t)}`);
	const areas = depois.filter((t) => t.kind === "area");
	console.log(
		`   áreas de chuva (moderada) detectadas: ${areas.length}${areas.length ? ` — maior ${Math.max(...areas.map((a) => a.pixelCount))} px` : ""}`,
	);
}

console.log(
	`\n${falhas === 0 ? "✅ VERIFICAÇÃO CONCLUÍDA" : `❌ ${falhas} FALHA(S)`}`,
);
