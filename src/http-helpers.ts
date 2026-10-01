/**
 * Helpers de HTTP do Monitor Ipiranga — extraídos de index.ts (01/10/2026).
 *
 * index.ts tinha 1.996 linhas com três monstros dentro (syncWeatherCycle 700
 * linhas, handleRequest 823, e estes helpers no meio). Cada fix que tocava o
 * router relia tudo. Extraído sem mudar comportamento: só organização.
 */

export interface IncomingRequest {
	url?: string;
	method?: string;
	headers?: {
		get?: (name: string) => string | null;
		[name: string]: unknown;
	};
	body?: unknown;
	json?: () => Promise<unknown>;
}

export function getHeader(req: IncomingRequest, name: string): string | null {
	if (!req) return null;
	if (req.headers && typeof req.headers.get === "function") {
		return req.headers.get(name);
	}
	if (req.headers) {
		const val = req.headers[name.toLowerCase()];
		if (Array.isArray(val)) return val[0] || null;
		if (typeof val === "string") return val;
	}
	return null;
}

export function getClientIp(req: IncomingRequest): string {
	return (
		getHeader(req, "x-forwarded-for")?.split(",")[0]?.trim() ||
		getHeader(req, "x-real-ip") ||
		"unknown"
	);
}

export async function getReqJson(req: IncomingRequest): Promise<unknown> {
	if (!req) return {};
	// `req.body` só vale como JSON já parseado quando o runtime entrega um
	// OBJETO (caso do Vercel/Node, onde o body chega parseado). No runtime Bun
	// `req.body` é o ReadableStream da requisição — tratá-lo como objeto fazia
	// todo POST chegar vazio (descoberto no teste local de 26/09/2026; em prod
	// o caminho é o do Vercel, então o efeito era só em dev/preview local).
	if (
		req.body &&
		typeof req.body === "object" &&
		typeof (req.body as ReadableStream).getReader !== "function"
	) {
		return req.body;
	}
	if (typeof req.json === "function") {
		return await req.json().catch(() => ({}));
	}
	return {};
}
