// Verifica a resolução de município do threat mais próximo (298 km) e
// onde Prudentópolis realmente fica vs Ipiranga.

import { getMunicipio, getMunicipioComFallback } from "../src/geo-municipio.js";
import { REGION_GRID, TARGET_IPIRANGA } from "../src/nowcast-service.js";
import { analyzeRadarNowcast, haversineKm } from "../src/radar-analysis.js";

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

// Distância real Ipiranga ↔ Prudentópolis (centro IBGE ~-25.212, -50.978)
const distIpiPru = haversineKm(-25.0244, -50.5847, -25.212, -50.978);
console.log(
	"Distância REAL Ipiranga ↔ Prudentópolis:",
	Math.round(distIpiPru),
	"km",
);

const t = nowcast.threats[0];
console.log("\nThreat mais próximo:");
console.log("  lat/lon:", t.lat.toFixed(3), t.lon.toFixed(3));
console.log("  distIpiranga (Camada A):", Math.round(t.distToTargetKm), "km");
const mMalha = getMunicipio(t.lat, t.lon);
console.log(
	"  município por malha IBGE:",
	mMalha ? mMalha.nome : "FORA DO PR (null)",
);
const mFall = getMunicipioComFallback(t.lat, t.lon, haversineKm);
console.log(
	"  comFallback:",
	mFall.municipio?.nome,
	"| fallbackUsado:",
	mFall.fallbackUsado,
);
const distPru = haversineKm(t.lat, t.lon, -25.212, -50.978);
console.log("  distância núcleo→Prudentópolis:", Math.round(distPru), "km");
