// Teste rápido do rótulo honesto de localização (incidente RS → São João do Triunfo)
import {
	getMunicipioComFallback,
	rotularLocalizacao,
} from "../src/geo-municipio.js";
import { haversineKm } from "../src/radar-analysis.js";

const casos: Array<{ nome: string; lat: number; lon: number }> = [
	{ nome: "núcleo no RS (Santa Maria)", lat: -29.378, lon: -53.362 },
	{ nome: "núcleo em SP (Pres. Prudente)", lat: -22.207, lon: -51.364 },
	{ nome: "núcleo no RS (Montenegro)", lat: -29.587, lon: -51.363 },
	{ nome: "Ipiranga/PR (na malha)", lat: -25.0244, lon: -50.5847 },
	{ nome: "Mafra/SC (na malha)", lat: -26.111, lon: -49.805 },
	{ nome: "Irati/SC (na malha)", lat: -26.655, lon: -52.892 },
	{ nome: "ponto no mar (fora)", lat: -27.5, lon: -46.5 },
];

let falhas = 0;
for (const c of casos) {
	const fb = getMunicipioComFallback(c.lat, c.lon, haversineKm);
	const r = rotularLocalizacao(c.lat, c.lon, haversineKm);
	const linha = `${c.nome} -> rotulo: "${r.nome}${r.uf ? " (" + r.uf + ")" : ""}"${r.metodo} | fallback=${fb.fallbackUsado} refDist=${fb.refDistKm ? Math.round(fb.refDistKm) + "km" : "-"}`;
	console.log(linha);
	// Validações
	if (c.nome.startsWith("núcleo no RS") && r.nome !== "região do RS") {
		console.log("  ❌ esperava 'região do RS'");
		falhas++;
	}
	if (c.nome === "núcleo em SP" && r.nome !== "região do SP") {
		console.log("  ❌ esperava 'região do SP'");
		falhas++;
	}
	if (c.nome === "Ipiranga/PR (na malha)" && r.nome !== "Ipiranga") {
		console.log("  ❌ esperava 'Ipiranga'");
		falhas++;
	}
	if (c.nome === "Mafra/SC (na malha)" && r.nome !== "Mafra") {
		console.log("  ❌ esperava 'Mafra' — veio: " + r.nome);
		falhas++;
	}
	if (c.nome === "Irati/SC (na malha)" && r.nome !== "Irati") {
		console.log("  ❌ esperava 'Irati' — veio: " + r.nome);
		falhas++;
	}
	if (
		c.nome === "ponto no mar (fora)" &&
		r.nome !== "fora da área monitorada"
	) {
		console.log("  ❌ esperava 'fora da área monitorada' — veio: " + r.nome);
		falhas++;
	}
}
console.log(falhas === 0 ? "\n✅ TODOS OS CASOS OK" : `\n❌ ${falhas} falhas`);
process.exit(falhas === 0 ? 0 : 1);
