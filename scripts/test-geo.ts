/**
 * Smoke test do getMunicipio() — valida point-in-polygon com a malha IBGE.
 * Uso: bun run scripts/test-geo.ts
 */
import { getMunicipio, getMunicipioComFallback } from "../src/geo-municipio.js";
import { haversineKm } from "../src/radar-analysis.js";

const cases: Array<{ lat: number; lon: number; esperado: string }> = [
	{ lat: -25.0244, lon: -50.5847, esperado: "Ipiranga" },
	{ lat: -24.512, lon: -50.414, esperado: "Tibagi" },
	{ lat: -25.095, lon: -50.158, esperado: "Ponta Grossa" },
	{ lat: -25.305, lon: -49.055, esperado: "Campina Grande do Sul" },
	// Núcleo real detectado em 09/08/2026 — o nearestCity antigo dizia
	// "Campina Grande do Sul", mas a malha IBGE diz Cerro Azul.
	{ lat: -25.046455790556582, lon: -49.131591796875, esperado: "Cerro Azul" },
	{ lat: -24.252, lon: -49.706, esperado: "Jaguariaíva" },
];

let fails = 0;
for (const c of cases) {
	const r = getMunicipio(c.lat, c.lon);
	const ok = r?.nome === c.esperado;
	if (!ok) fails++;
	console.log(
		`${ok ? "✓" : "✗"} (${c.lat.toFixed(4)}, ${c.lon.toFixed(4)}) → ${r?.nome ?? "FORA DO PR"} (esperado: ${c.esperado})`,
	);
}

// Fora do PR → fallback regional
const fora = getMunicipioComFallback(-30.0, -51.0, haversineKm);
console.log(
	`${fora.fallbackUsado ? "✓" : "✗"} fora do PR → fallback: ${fora.municipio?.nome}`,
);
if (!fora.fallbackUsado) fails++;

console.log(
	fails === 0 ? "\n✅ TODOS OS TESTES PASSARAM" : `\n❌ ${fails} FALHAS`,
);
process.exit(fails === 0 ? 0 : 1);
