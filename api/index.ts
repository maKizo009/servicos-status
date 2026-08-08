import { handleRequest } from "../src/index";

export default async function handler(req: any, res: any) {
	try {
		const response = await handleRequest(req);
		if (res && typeof res.status === "function") {
			const status = response.status;
			const body = await response.text();
			const contentType = response.headers.get("content-type") || "application/json";
			const cacheControl = response.headers.get("cache-control");

			res.setHeader("Content-Type", contentType);
			if (cacheControl) {
				res.setHeader("Cache-Control", cacheControl);
			}
			return res.status(status).send(body);
		}
		return response;
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		if (res && typeof res.status === "function") {
			return res.status(500).json({ error: msg });
		}
		return Response.json({ error: msg }, { status: 500 });
	}
}
