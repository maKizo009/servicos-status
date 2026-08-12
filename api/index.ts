import { handleRequest } from "../src/index.js";

/** Origens permitidas no CORS (whitelist — nunca `*`). */
const ALLOWED_ORIGINS = new Set([
	"https://servicos-status.vercel.app",
	"https://os-status.vercel.app",
	"http://localhost:3030",
]);

/** Headers de segurança aplicados em TODAS as respostas (incl. erros). */
const SECURITY_HEADERS: Record<string, string> = {
	"Content-Security-Policy":
		"default-src 'self'; script-src 'self' 'unsafe-inline' https://unpkg.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://unpkg.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob: https:; connect-src 'self' https:; media-src 'self' https:; frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'",
	"X-Frame-Options": "DENY",
	"X-Content-Type-Options": "nosniff",
	"Referrer-Policy": "strict-origin-when-cross-origin",
	"Permissions-Policy": "geolocation=(), camera=(), microphone=(), payment=(), usb=()",
};

/** Aplica CORS com whitelist de origens (sem credenciais cross-origin). */
function applyCors(res: any, originHeader: string | null): void {
	if (originHeader && ALLOWED_ORIGINS.has(originHeader)) {
		res.setHeader("Access-Control-Allow-Origin", originHeader);
		res.setHeader("Vary", "Origin");
	}
	res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, HEAD");
	res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function applySecurityHeaders(res: any): void {
	for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
		res.setHeader(k, v);
	}
}

export default async function handler(req: any, res: any) {
	const origin = req.headers?.origin ?? null;
	try {
		const response = await handleRequest(req);
		if (res && typeof res.status === "function") {
			const status = response.status;
			const body = await response.text();
			const contentType = response.headers.get("content-type") || "application/json; charset=utf-8";
			const cacheControl = response.headers.get("cache-control");

			res.setHeader("Content-Type", contentType);
			applyCors(res, origin);
			applySecurityHeaders(res);
			// Set-Cookie precisa ser repassado (login admin/WebAuthn) — o
			// Response Web API original pode ter mais de um (múltiplos cookies)
			const setCookie = response.headers.getSetCookie?.() ?? null;
			if (setCookie && setCookie.length > 0) {
				res.setHeader("Set-Cookie", setCookie);
			} else {
				const sc = response.headers.get("set-cookie");
				if (sc) res.setHeader("Set-Cookie", sc);
			}
			if (cacheControl) {
				res.setHeader("Cache-Control", cacheControl);
			}
			return res.status(status).send(body);
		}
		return response;
	} catch (err: unknown) {
		// Nunca vazar mensagens internas pro cliente (achado pentest:
		// catch devolvia {error: msg} com stack/paths em 500).
		console.error("API wrapper error:", err instanceof Error ? err.stack ?? err.message : err);
		if (res && typeof res.status === "function") {
			applyCors(res, origin);
			applySecurityHeaders(res);
			return res.status(500).json({ error: "Erro interno" });
		}
		return Response.json({ error: "Erro interno" }, { status: 500 });
	}
}
