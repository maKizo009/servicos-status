/**
 * Build offline da Malha Municipal do Sul (PR + SC + SP) — fonte IBGE.
 *
 * Baixa a malha municipal (API de Malhas v3) + nomes (API de Localidades v1)
 * dos estados 41 (PR), 42 (SC) e 35 (SP) e gera
 * `src/data/sul-municipios.ts` — módulo TS com os dados embutidos
 * (o bundler da Vercel não suporta import JSON no Node 22).
 *
 * Formato: [{ c: "4100103", n: "Abatiá", g: [[[lon,lat],...],...] }, ...]
 *
 * Uso: bun run scripts/build-malha-sul.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, "..", "src", "data", "sul-municipios.ts");

const ESTADOS = [
	{ uf: "41", sigla: "PR" },
	{ uf: "42", sigla: "SC" },
	{ uf: "35", sigla: "SP" },
] as const;

const MALHA_URL = (uf: string) =>
	`https://servicodados.ibge.gov.br/api/v3/malhas/estados/${uf}?formato=application/vnd.geo+json&qualidade=intermediaria&intrarregiao=municipio`;
const NOMES_URL = (uf: string) =>
	`https://servicodados.ibge.gov.br/api/v1/localidades/municipios?estados=${uf}`;

interface Feature {
	properties: { codarea?: string };
	geometry: { type: string; coordinates: unknown };
}

async function fetchJson(url: string): Promise<unknown> {
	const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
	if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
	return res.json();
}

const roundRing = (ring: number[][]): number[][] =>
	ring.map(([x, y]) => [Math.round(x * 1e4) / 1e4, Math.round(y * 1e4) / 1e4]);

async function main(): Promise<void> {
	const compact: Array<{ c: string; n: string; g: number[][][] }> = [];

	for (const est of ESTADOS) {
		console.log(`→ Baixando malha municipal de ${est.sigla}...`);
		const malha = (await fetchJson(MALHA_URL(est.uf))) as {
			features: Feature[];
		};
		console.log(`→ Baixando nomes de ${est.sigla}...`);
		const localidades = (await fetchJson(NOMES_URL(est.uf))) as Array<{
			id: number;
			nome: string;
		}>;
		const nomePorCodigo = new Map(
			localidades.map((m) => [String(m.id), m.nome]),
		);

		let count = 0;
		for (const f of malha.features) {
			const codigo = f.properties.codarea ?? "";
			const geom = f.geometry as {
				type: string;
				coordinates: number[][][] | number[][][][];
			};
			const rings: number[][][] = [];
			if (geom.type === "Polygon") {
				rings.push(...(geom.coordinates as number[][][]).map(roundRing));
			} else if (geom.type === "MultiPolygon") {
				for (const poly of geom.coordinates as number[][][][]) {
					rings.push(...poly.map(roundRing));
				}
			}
			if (rings.length === 0) continue;
			compact.push({
				c: codigo,
				n: nomePorCodigo.get(codigo) ?? codigo,
				g: rings,
			});
			count++;
		}
		console.log(`  ${est.sigla}: ${count} municípios`);
	}

	compact.sort((a, b) => a.c.localeCompare(b.c));

	mkdirSync(dirname(OUT), { recursive: true });
	writeFileSync(
		OUT,
		`// GERADO por scripts/build-malha-sul.ts — não editar à mão.\n// Malha Municipal do Sul (IBGE): PR 41 + SC 42 + SP 35 — ${compact.length} municípios.\n// Formato: { c: codigoIBGE, n: nome, g: anéis[][lon,lat] } (código 41/42/35 → UF)\n// Anotação explícita: evita TS7056 (tipo inferido excede o limite de serialização\n// com 1339 municípios — o "as const" inferiria literais gigantes).\ntype MalhaSulEntry = { c: string; n: string; g: number[][][] };\nconst MALHA_SUL: MalhaSulEntry[] = ${JSON.stringify(compact)};\nexport default MALHA_SUL;\n`,
	);
	console.log(
		`✅ ${OUT} gerado: ${compact.length} municípios, ${(
			JSON.stringify(compact).length / 1024
		).toFixed(1)} KB`,
	);

	// Sanity checks: Ipiranga (PR), um município de SC e um de SP
	for (const nome of ["Ipiranga", "Florianópolis", "São Paulo"]) {
		const m = compact.find((x) => x.n === nome);
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
