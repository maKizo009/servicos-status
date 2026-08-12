// Debug da resolução de município: pontos de controle + bboxes candidatos.

import MALHA_SUL from "../src/data/sul-municipios.js";
import { getMunicipio, getMunicipioComFallback } from "../src/geo-municipio.js";
import { haversineKm } from "../src/radar-analysis.js";

const pontos = [
	{ nome: "Núcleo real (oeste SC)", lat: -26.592, lon: -52.922 },
	{ nome: "Xanxerê/SC centro", lat: -26.87, lon: -52.4 },
	{ nome: "Abelardo Luz/SC", lat: -26.57, lon: -52.33 },
	{ nome: "Irati/PR centro", lat: -25.47, lon: -50.65 },
	{ nome: "Ipiranga/PR", lat: -25.0244, lon: -50.5847 },
	{ nome: "São Paulo/SP centro", lat: -23.55, lon: -46.63 },
];

for (const p of pontos) {
	const m = getMunicipio(p.lat, p.lon);
	console.log(
		`${p.nome} (${p.lat}, ${p.lon}) → ${m ? `${m.nome} (${m.uf}) ${m.codigo}` : "FORA"}`,
	);
}

// Bboxes que contêm o núcleo
console.log("\nBboxes contendo o núcleo (-26.592, -52.922):");
const malha = MALHA_SUL as unknown as Array<{
	c: string;
	n: string;
	g: number[][][];
}>;
let n = 0;
for (const m of malha) {
	let minLon = Infinity,
		maxLon = -Infinity,
		minLat = Infinity,
		maxLat = -Infinity;
	for (const ring of m.g) {
		for (const [lon, lat] of ring) {
			if (lon < minLon) minLon = lon;
			if (lon > maxLon) maxLon = lon;
			if (lat < minLat) minLat = lat;
			if (lat > maxLat) maxLat = lat;
		}
	}
	if (
		-52.922 >= minLon &&
		-52.922 <= maxLon &&
		-26.592 >= minLat &&
		-26.592 <= maxLat
	) {
		console.log(
			`  ${m.n} (${m.c}): lon ${minLon}..${maxLon}, lat ${minLat}..${maxLat}`,
		);
		n++;
		if (n > 8) break;
	}
}
