import MALHA_PR from "./data/pr-municipios.js";

/**
 * Geolocalização por point-in-polygon usando a Malha Municipal do IBGE (PR).
 *
 * Substitui o antigo nearestCity() (cidade mais próxima de uma lista fixa por
 * haversine), que errava: um núcleo podia estar dentro de um município não
 * listado (ex: Cerro Azul) e o código reportava o mais próximo da lista
 * (ex: Campina Grande do Sul).
 *
 * Fonte: https://servicodados.ibge.gov.br/api/v3/malhas/estados/41?formato=application/vnd.geo+json
 * Gerado offline por scripts/build-malha-pr.ts → src/data/pr-municipios.ts
 * (módulo TS embutido no bundle — evita import JSON, que quebra no Node 22
 * ESM da Vercel: ERR_IMPORT_ATTRIBUTE_MISSING).
 * Formato: [{ c: codigoIBGE, n: nome, g: anéis[][lon,lat] }]
 */

export interface Municipio {
	/** Código IBGE de 7 dígitos (ex: "4110508") */
	codigo: string;
	/** Nome do município (ex: "Ipiranga") */
	nome: string;
}

type Ring = number[][]; // [[lon, lat], ...]

interface MalhaEntry {
	c: string;
	n: string;
	g: Ring[];
}

const malha = MALHA_PR as unknown as MalhaEntry[];

/**
 * Ray casting: ponto [lon, lat] dentro de um anel fechado?
 * O anel usa ordem GeoJSON [lon, lat].
 */
function pointInRing(lon: number, lat: number, ring: Ring): boolean {
	let inside = false;
	for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
		const [xi, yi] = ring[i];
		const [xj, yj] = ring[j];
		const intersect =
			yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
		if (intersect) inside = !inside;
	}
	return inside;
}

/** Ponto dentro de um conjunto de anéis (anel 0 = externo, demais = buracos)? */
function pointInRings(lon: number, lat: number, rings: Ring[]): boolean {
	if (rings.length === 0) return false;
	if (!pointInRing(lon, lat, rings[0])) return false;
	for (let i = 1; i < rings.length; i++) {
		if (pointInRing(lon, lat, rings[i])) return false;
	}
	return true;
}

/**
 * Retorna o município (código + nome) que contém o ponto lat/lon,
 * ou null se estiver fora do estado do Paraná.
 *
 * Performance: ~1.6ms por lookup (399 municípios, varredura linear).
 * A ordem do array é por código IBGE (ordenação determinística do build).
 */
export function getMunicipio(lat: number, lon: number): Municipio | null {
	for (const m of malha) {
		if (pointInRings(lon, lat, m.g)) {
			return { codigo: m.c, nome: m.n };
		}
	}
	return null;
}

/**
 * Versão com fallback: se o ponto estiver fora do PR (ou a malha falhar),
 * retorna o município mais próximo por haversine a partir de uma lista
 * de referência regional. Nunca retorna null — sempre um nome legível.
 */
export function getMunicipioComFallback(
	lat: number,
	lon: number,
	haversineKm: (
		lat1: number,
		lon1: number,
		lat2: number,
		lon2: number,
	) => number,
): { municipio: Municipio | null; fallbackUsado: boolean } {
	const m = getMunicipio(lat, lon);
	if (m) return { municipio: m, fallbackUsado: false };

	// Fallback: cidades de referência da região (Campos Gerais + vizinhança)
	const refs: Array<{ nome: string; lat: number; lon: number }> = [
		{ nome: "Ipiranga", lat: -25.0244, lon: -50.5847 },
		{ nome: "Ponta Grossa", lat: -25.095, lon: -50.158 },
		{ nome: "Tibagi", lat: -24.512, lon: -50.414 },
		{ nome: "Telêmaco Borba", lat: -24.324, lon: -50.616 },
		{ nome: "Imbituva", lat: -25.229, lon: -50.6 },
		{ nome: "Prudentópolis", lat: -25.212, lon: -50.978 },
		{ nome: "Reserva", lat: -24.65, lon: -50.85 },
		{ nome: "Carambeí", lat: -24.952, lon: -50.103 },
		{ nome: "Castro", lat: -24.79, lon: -50.011 },
		{ nome: "Piraí do Sul", lat: -24.526, lon: -49.948 },
		{ nome: "Jaguariaíva", lat: -24.252, lon: -49.706 },
		{ nome: "Arapoti", lat: -24.16, lon: -49.827 },
		{ nome: "Ventania", lat: -24.246, lon: -50.242 },
		{ nome: "Ortigueira", lat: -24.208, lon: -50.944 },
		{ nome: "Curitiba", lat: -25.429, lon: -49.271 },
		{ nome: "Palmeira", lat: -25.429, lon: -50.003 },
		{ nome: "Teixeira Soares", lat: -25.369, lon: -50.46 },
		{ nome: "São João do Triunfo", lat: -25.683, lon: -50.295 },
		{ nome: "Ivaí", lat: -25.008, lon: -50.858 },
		{ nome: "Campina Grande do Sul", lat: -25.305, lon: -49.055 },
	];
	let best = refs[0];
	let bestKm = Infinity;
	for (const r of refs) {
		const d = haversineKm(lat, lon, r.lat, r.lon);
		if (d < bestKm) {
			bestKm = d;
			best = r;
		}
	}
	return { municipio: { codigo: "", nome: best.nome }, fallbackUsado: true };
}
