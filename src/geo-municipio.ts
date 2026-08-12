import MALHA_SUL from "./data/sul-municipios.js";

/**
 * Geolocalização por point-in-polygon usando a Malha Municipal do IBGE
 * (PR + SC + SP — o grid 4x4 do nowcast cobre os 3 estados).
 *
 * Substitui o antigo nearestCity() (cidade mais próxima de uma lista fixa por
 * haversine), que errava: um núcleo podia estar dentro de um município não
 * listado (ex: Cerro Azul) e o código reportava o mais próximo da lista.
 * Com a malha tri-estado, núcleos em SC/SP resolvem o município REAL
 * (incidente 2026-08-12: núcleo no oeste de SC era reportado como
 * "Prudentópolis" porque a malha só tinha o PR).
 *
 * Fonte: https://servicodados.ibge.gov.br/api/v3/malhas/estados/{41|42|35}?formato=application/vnd.geo+json
 * Gerado offline por scripts/build-malha-sul.ts → src/data/sul-municipios.ts
 * (módulo TS embutido no bundle — evita import JSON, que quebra no Node 22
 * ESM da Vercel: ERR_IMPORT_ATTRIBUTE_MISSING).
 * Formato: [{ c: codigoIBGE, n: nome, g: anéis[][lon,lat] }]
 */

export interface Municipio {
	/** Código IBGE de 7 dígitos (ex: "4110508") */
	codigo: string;
	/** Nome do município (ex: "Ipiranga") */
	nome: string;
	/** UF derivada do código (41=PR, 42=SC, 35=SP) */
	uf: string;
}

type Ring = number[][]; // [[lon, lat], ...]

interface MalhaEntry {
	c: string;
	n: string;
	g: Ring[];
}

const malha = MALHA_SUL as unknown as MalhaEntry[];

/** UF a partir do código IBGE (2 primeiros dígitos). */
function ufFromCodigo(codigo: string): string {
	const uf = codigo.slice(0, 2);
	if (uf === "42") return "SC";
	if (uf === "35") return "SP";
	return "PR";
}

/**
 * Índice espacial: bounding box por município (pré-computado uma vez).
 * O point-in-polygon é caro (~4µs/anel); com 1339 municípios a varredura
 * linear custaria ~5ms por lookup. O teste de bbox (4 comparações) elimina
 * ~99% dos candidatos antes do ray casting.
 */
const bboxCache = new Map<
	number,
	{ minLon: number; maxLon: number; minLat: number; maxLat: number }
>();

function bboxOf(
	idx: number,
	rings: Ring[],
): {
	minLon: number;
	maxLon: number;
	minLat: number;
	maxLat: number;
} {
	const cached = bboxCache.get(idx);
	if (cached) return cached;
	let minLon = Infinity;
	let maxLon = -Infinity;
	let minLat = Infinity;
	let maxLat = -Infinity;
	for (const ring of rings) {
		for (const [lon, lat] of ring) {
			if (lon < minLon) minLon = lon;
			if (lon > maxLon) maxLon = lon;
			if (lat < minLat) minLat = lat;
			if (lat > maxLat) maxLat = lat;
		}
	}
	const bb = { minLon, maxLon, minLat, maxLat };
	bboxCache.set(idx, bb);
	return bb;
}

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
 * Retorna o município (código + nome + UF) que contém o ponto lat/lon,
 * ou null se estiver fora de PR/SC/SP (ex: MS, mar, outros estados).
 *
 * Performance: bbox pré-filtro + ray casting — ~0.5-1ms por lookup.
 */
export function getMunicipio(lat: number, lon: number): Municipio | null {
	for (let i = 0; i < malha.length; i++) {
		const m = malha[i];
		const bb = bboxOf(i, m.g);
		if (
			lon < bb.minLon ||
			lon > bb.maxLon ||
			lat < bb.minLat ||
			lat > bb.maxLat
		) {
			continue;
		}
		if (pointInRings(lon, lat, m.g)) {
			return { codigo: m.c, nome: m.n, uf: ufFromCodigo(m.c) };
		}
	}
	return null;
}

/**
 * Versão com fallback: se o ponto estiver fora da malha (MS, outros estados,
 * mar), retorna o município mais próximo por haversine a partir de uma lista
 * de referência regional. Nunca retorna null — sempre um nome legível.
 * `refDistKm` = distância do ponto até a referência escolhida (null quando o
 * município resolveu na malha). O chamador decide se a referência é razoável.
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
): {
	municipio: Municipio | null;
	fallbackUsado: boolean;
	refDistKm: number | null;
} {
	const m = getMunicipio(lat, lon);
	if (m) return { municipio: m, fallbackUsado: false, refDistKm: null };

	// Fallback: cidades de referência da região (Campos Gerais + vizinhança).
	// Só é usado fora da malha tri-estado — muito mais raro que antes.
	const refs: Array<{ nome: string; uf: string; lat: number; lon: number }> = [
		{ nome: "Ipiranga", uf: "PR", lat: -25.0244, lon: -50.5847 },
		{ nome: "Ponta Grossa", uf: "PR", lat: -25.095, lon: -50.158 },
		{ nome: "Tibagi", uf: "PR", lat: -24.512, lon: -50.414 },
		{ nome: "Telêmaco Borba", uf: "PR", lat: -24.324, lon: -50.616 },
		{ nome: "Imbituva", uf: "PR", lat: -25.229, lon: -50.6 },
		{ nome: "Prudentópolis", uf: "PR", lat: -25.212, lon: -50.978 },
		{ nome: "Reserva", uf: "PR", lat: -24.65, lon: -50.85 },
		{ nome: "Carambeí", uf: "PR", lat: -24.952, lon: -50.103 },
		{ nome: "Castro", uf: "PR", lat: -24.79, lon: -50.011 },
		{ nome: "Piraí do Sul", uf: "PR", lat: -24.526, lon: -49.948 },
		{ nome: "Jaguariaíva", uf: "PR", lat: -24.252, lon: -49.706 },
		{ nome: "Arapoti", uf: "PR", lat: -24.16, lon: -49.827 },
		{ nome: "Ventania", uf: "PR", lat: -24.246, lon: -50.242 },
		{ nome: "Ortigueira", uf: "PR", lat: -24.208, lon: -50.944 },
		{ nome: "Curitiba", uf: "PR", lat: -25.429, lon: -49.271 },
		{ nome: "Palmeira", uf: "PR", lat: -25.429, lon: -50.003 },
		{ nome: "Teixeira Soares", uf: "PR", lat: -25.369, lon: -50.46 },
		{ nome: "São João do Triunfo", uf: "PR", lat: -25.683, lon: -50.295 },
		{ nome: "Ivaí", uf: "PR", lat: -25.008, lon: -50.858 },
		{ nome: "Campina Grande do Sul", uf: "PR", lat: -25.305, lon: -49.055 },
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
	return {
		municipio: { codigo: "", nome: best.nome, uf: best.uf },
		fallbackUsado: true,
		refDistKm: bestKm,
	};
}

/**
 * Distância máxima (km) entre o núcleo e a cidade de referência do fallback
 * para o nome ainda ser citado no boletim. Acima disso, o nome engana
 * (incidente 2026-08-12: núcleo no RS era citado como "São João do Triunfo",
 * a ~500 km do ponto real — o VLM repetia o nome injetado).
 */
export const REF_MAX_KM = 80;

/** UF aproximada por bounding box dos estados cobertos pelo grid do nowcast
 *  (Sul + MS). Usada SÓ para rotular "região do X" quando o ponto está fora
 *  da malha — nome de região, nunca de município. Bboxes oficiais (IBGE)
 *  com margem de 0.25° (aproximação aceitável para região). */
const ESTADOS_BBOX: Array<{
	uf: string;
	minLat: number;
	maxLat: number;
	minLon: number;
	maxLon: number;
}> = [
	{ uf: "RS", minLat: -33.75, maxLat: -27.05, minLon: -57.65, maxLon: -49.65 },
	{ uf: "SC", minLat: -29.35, maxLat: -25.95, minLon: -53.95, maxLon: -48.35 },
	{ uf: "PR", minLat: -26.75, maxLat: -22.5, minLon: -54.65, maxLon: -48.0 },
	{ uf: "SP", minLat: -25.35, maxLat: -19.75, minLon: -53.15, maxLon: -44.15 },
	{ uf: "MS", minLat: -24.05, maxLat: -17.0, minLon: -58.15, maxLon: -50.85 },
];

export function ufDeCoordenada(lat: number, lon: number): string | null {
	for (const e of ESTADOS_BBOX) {
		if (
			lat >= e.minLat &&
			lat <= e.maxLat &&
			lon >= e.minLon &&
			lon <= e.maxLon
		) {
			return e.uf;
		}
	}
	return null;
}

/**
 * Rótulo de localização HONESTO para o prompt do VLM:
 * - dentro da malha → município real (UF + método vazio)
 * - fora da malha mas com referência ≤ REF_MAX_KM → referência regional
 * - fora da malha longe de tudo → "região do {UF}" (bbox) — nunca um nome de
 *   município a centenas de km do núcleo
 */
export function rotularLocalizacao(
	lat: number,
	lon: number,
	haversineKm: (
		lat1: number,
		lon1: number,
		lat2: number,
		lon2: number,
	) => number,
): {
	nome: string;
	uf: string | null;
	metodo: string;
	municipio: Municipio | null;
} {
	const { municipio, fallbackUsado, refDistKm } = getMunicipioComFallback(
		lat,
		lon,
		haversineKm,
	);
	if (municipio && (!fallbackUsado || (refDistKm ?? Infinity) <= REF_MAX_KM)) {
		return {
			nome: municipio.nome,
			uf: municipio.uf,
			metodo: fallbackUsado
				? " (referência regional — fora da malha IBGE)"
				: "",
			municipio,
		};
	}
	const uf = ufDeCoordenada(lat, lon);
	return {
		nome: uf ? `região do ${uf}` : "fora da área monitorada",
		uf: null,
		metodo: " (fora da malha IBGE — sem município mapeado)",
		municipio: null,
	};
}
