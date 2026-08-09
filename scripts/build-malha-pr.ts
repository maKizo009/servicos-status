/**
 * Build offline da Malha Municipal do Paraná (fonte: IBGE).
 *
 * Baixa:
 *  1. Malha municipal do PR em GeoJSON (API de Malhas v3)
 *  2. Nomes dos municípios (API de Localidades v1)
 *
 * E gera `src/data/pr-municipios.json` num formato compacto:
 *   [{ c: "4100103", n: "Abatiá", g: [[[lon,lat],...],...] }, ...]
 *   - c = código IBGE do município (7 dígitos)
 *   - n = nome do município
 *   - g = anéis dos polígonos (GeoJSON: [lon, lat]), arredondados a 4 casas
 *        (~11m de precisão — suficiente para fronteiras municipais)
 *
 * Uso: bun run scripts/build-malha-pr.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, "..", "src", "data", "pr-municipios.json");

const MALHA_URL =
	"https://servicodados.ibge.gov.br/api/v3/malhas/estados/41?formato=application/vnd.geo+json&qualidade=intermediaria&intrarregiao=municipio";
const NOMES_URL =
	"https://servicodados.ibge.gov.br/api/v1/localidades/municipios?estados=41";

async function main(): Promise<void> {
	console.log("→ Baixando malha municipal do PR...");
	const res = await fetch(MALHA_URL, { signal: AbortSignal.timeout(60_000) });
	if (!res.ok) throw new Error(`Malha HTTP ${res.status}`);
	const malha = (await res.json()) as {
		features: Array<{
			properties: { codarea?: string };
			geometry: { type: string; coordinates: unknown };
		}>;
	};

	console.log("→ Baixando nomes dos municípios...");
	const res2 = await fetch(NOMES_URL, { signal: AbortSignal.timeout(60_000) });
	if (!res2.ok) throw new Error(`Localidades HTTP ${res2.status}`);
	const localidades = (await res2.json()) as Array<{
		id: number;
		nome: string;
	}>;

	const nomePorCodigo = new Map(localidades.map((m) => [String(m.id), m.nome]));

	// Arredonda coordenadas para 4 casas decimais (~11m)
	const roundRing = (ring: number[][]): number[][] =>
		ring.map(([x, y]) => [
			Math.round(x * 1e4) / 1e4,
			Math.round(y * 1e4) / 1e4,
		]);

	const compact = malha.features
		.map((f) => {
			const codigo = f.properties.codarea ?? "";
			const geom = f.geometry as {
				type: string;
				coordinates: number[][][] | number[][][][];
			};
			let rings: number[][][] = [];
			if (geom.type === "Polygon") {
				rings = (geom.coordinates as number[][][]).map(roundRing);
			} else if (geom.type === "MultiPolygon") {
				for (const poly of geom.coordinates as number[][][][]) {
					rings.push(...poly.map(roundRing));
				}
			}
			return { c: codigo, n: nomePorCodigo.get(codigo) ?? codigo, g: rings };
		})
		.filter((m) => m.g.length > 0);

	compact.sort((a, b) => a.c.localeCompare(b.c));

	mkdirSync(dirname(OUT), { recursive: true });
	writeFileSync(OUT, JSON.stringify(compact));
	console.log(
		`✅ ${OUT} gerado: ${compact.length} municípios, ${(
			JSON.stringify(compact).length / 1024
		).toFixed(1)} KB`,
	);

	// Sanity check: Ipiranga e Cerro Azul presentes
	const check = (nome: string) => compact.find((m) => m.n === nome);
	for (const nome of ["Ipiranga", "Cerro Azul", "Campina Grande do Sul"]) {
		const m = check(nome);
		console.log(
			m
				? `  ✓ ${nome}: ${m.c} (${m.g.length} anéis)`
				: `  ✗ ${nome} NÃO encontrado`,
		);
	}
}

main().catch((err) => {
	console.error("Falha:", err);
	process.exit(1);
});
