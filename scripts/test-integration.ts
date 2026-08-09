/**
 * Teste de integração: import do JSON da malha + análise de radar real.
 * Valida que o bundle aguenta o JSON e que o locationNote usa o município real.
 * Uso: bun run scripts/test-integration.ts
 */
import { getMunicipioComFallback } from "../src/geo-municipio.js";
import { haversineKm } from "../src/radar-analysis.js";

// 1. Import do JSON funciona (memória do processo)
const memBefore = process.memoryUsage().heapUsed / 1024 / 1024;
const { default: malha } = await import("../src/data/pr-municipios.json");
const memAfter = process.memoryUsage().heapUsed / 1024 / 1024;
console.log(
	`✅ Malha carregada: ${(malha as unknown[]).length} municípios | heap +${(memAfter - memBefore).toFixed(1)} MB`,
);

// 2. Simula o núcleo real detectado (09/08/2026) — antigo nearestCity dizia
//    "Campina Grande do Sul", a malha IBGE deve dizer Cerro Azul.
const nucleoReal = { lat: -25.046455790556582, lon: -49.131591796875 };
const { municipio, fallbackUsado } = getMunicipioComFallback(
	nucleoReal.lat,
	nucleoReal.lon,
	haversineKm,
);
const ipirangaKm = haversineKm(
	nucleoReal.lat,
	nucleoReal.lon,
	-25.0244,
	-50.5847,
);
console.log(
	`✅ Núcleo real → município: ${municipio?.nome} (${municipio?.codigo}) | ${Math.round(ipirangaKm)} km de Ipiranga | fallback: ${fallbackUsado}`,
);

// 3. O que o VLM vai receber no locationNote
const locationNote = `- Núcleo mais intenso em (${nucleoReal.lat.toFixed(2)}, ${nucleoReal.lon.toFixed(2)}): município ${municipio?.nome}; dista ${Math.round(ipirangaKm)} km de Ipiranga`;
console.log(`📝 locationNote: ${locationNote}`);

if (municipio?.nome !== "Cerro Azul") {
	console.error("❌ Esperava Cerro Azul!");
	process.exit(1);
}
console.log("✅ INTEGRAÇÃO OK — VLM agora fala do município real");
