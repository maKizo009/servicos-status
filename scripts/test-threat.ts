/**
 * Teste da análise de ameaça: veredicto + projeção de trajetória.
 * Cenário real: núcleo em Guaraqueçaba (-25.159, -48.5402) movendo 91° L.
 * Uso: bun run scripts/test-threat.ts
 */
import { getMunicipioComFallback } from "../src/geo-municipio.js";
import {
	assessThreat,
	haversineKm,
	projectCell,
} from "../src/radar-analysis.js";

const IPIRANGA = { lat: -25.0244, lon: -50.5847 };

function describe(
	nome: string,
	lat: number,
	lon: number,
	dir: number,
	speed: number,
) {
	const v = assessThreat(
		lat,
		lon,
		{ directionDeg: dir, speedKmh: speed },
		IPIRANGA.lat,
		IPIRANGA.lon,
	);
	const { municipio } = getMunicipioComFallback(lat, lon, haversineKm);
	const d = haversineKm(lat, lon, IPIRANGA.lat, IPIRANGA.lon);
	console.log(`\n=== ${nome} ===`);
	console.log(
		`  núcleo: ${municipio?.nome} (${lat.toFixed(2)}, ${lon.toFixed(2)}) | ${Math.round(d)} km de Ipiranga`,
	);
	console.log(`  movimento: ${dir}° a ${speed} km/h`);
	console.log(
		`  veredicto: ${v.approach} (radial ${v.radialKmh.toFixed(1)} km/h)${v.etaMin ? ` | ETA ~${Math.round(v.etaMin)} min` : ""}`,
	);
	// projeção
	const proj = [30, 60, 120].map((t) => {
		const p = projectCell(lat, lon, { directionDeg: dir, speedKmh: speed }, t);
		const pm = getMunicipioComFallback(p.lat, p.lon, haversineKm);
		return `${pm.municipio?.nome} (${t}min)`;
	});
	console.log(`  projeção: ${proj.join(" → ")}`);
	return v;
}

// 1. O caso real reportado pelo Dave (Guaraqueçaba, L)
const v1 = describe(
	"CASO REAL (Guaraqueçaba → L)",
	-25.159,
	-48.5402,
	91,
	36.3,
);
if (v1.approach !== "receding") {
	console.error(
		"❌ Esperava receding (núcleo a leste indo para leste = afastando)",
	);
	process.exitCode = 1;
} else {
	console.log("✅ Veredicto correto: afastando-se");
}

// 2. Caso oposto: núcleo a oeste indo para leste = APROXIMANDO
const v2 = describe(
	"Núcleo a OESTE indo para L (deve APROXIMAR)",
	-25.1,
	-52.5,
	91,
	40,
);
if (v2.approach !== "approaching") {
	console.error("❌ Esperava approaching");
	process.exitCode = 1;
} else {
	console.log("✅ Veredicto correto: aproximando-se");
}

// 3. Caso tangencial: núcleo ao norte indo para leste
describe("Núcleo ao NORTE indo para L (tangencial)", -24.2, -50.5, 91, 40);

// 4. Vindo de Ponta Grossa direto pra Ipiranga (aprox. SE)
describe("Ponta Grossa → Ipiranga (deve APROXIMAR)", -25.095, -50.158, 200, 30);

process.exit(process.exitCode ?? 0);
