import { handleRequest } from "../src/index.js";

// Endpoint temporário de diagnóstico: testa o getMunicipio no runtime da Vercel.
// TODO: remover após validar o deploy da malha IBGE.
export default async function handler(req: any, res: any) {
	try {
		const { getMunicipio } = await import("../src/geo-municipio.js");
		const tests = [
			{ lat: -25.0244, lon: -50.5847, label: "Ipiranga" },
			{ lat: -25.046455790556582, lon: -49.131591796875, label: "núcleo real" },
		];
		const out = tests.map((t) => ({
			label: t.label,
			result: getMunicipio(t.lat, t.lon),
		}));
		const json = JSON.stringify({ ok: true, out });
		res.setHeader("Content-Type", "application/json");
		return res.status(200).send(json);
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		res.setHeader("Content-Type", "application/json");
		return res.status(500).json({ ok: false, error: msg, stack: err instanceof Error ? err.stack : undefined });
	}
}
