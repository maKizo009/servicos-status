import { handleRequest } from "../src/index.js";

export default async function handler(req: any, res: any) {
	try {
		const response = await handleRequest(req);
		if (res && typeof res.status === "function") {
			const status = response.status;
			const body = await response.text();
			const contentType = response.headers.get("content-type") || "application/json; charset=utf-8";
			const cacheControl = response.headers.get("cache-control");

			res.setHeader("Content-Type", contentType);
			res.setHeader("Access-Control-Allow-Origin", "*");
			res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, HEAD");
			res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
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
		const msg = err instanceof Error ? err.message : String(err);
		if (res && typeof res.status === "function") {
			res.setHeader("Access-Control-Allow-Origin", "*");
			return res.status(500).json({ error: msg });
		}
		return Response.json({ error: msg }, { status: 500 });
	}
}
