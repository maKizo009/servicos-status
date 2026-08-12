import { runAllChecks } from "../src/checker.js";
import { loadConfig } from "../src/config.js";
import {
	initDb,
	saveBgpResult,
	saveConnectivityResult,
	saveEventLog,
	savePortalResult,
} from "../src/db.js";
import { syncWeatherCycle } from "../src/index.js";
import { EventTracker } from "../src/state.js";
import { sendCopelAlert, sendSaneparAlert } from "../src/telegram.js";

export default async function handler(req: any, res: any) {
	// ==== DIAGNÓSTICO TEMPORÁRIO (remover após resolver o VLM Gemini) ====
	if (req?.url?.includes("diag=1")) {
		const out: Record<string, unknown> = {
			hasGeminiKey: Boolean(process.env.GEMINI_API_KEY),
			geminiKeyLen: process.env.GEMINI_API_KEY?.length ?? 0,
			geminiKeyPrefix: process.env.GEMINI_API_KEY
				? String(process.env.GEMINI_API_KEY).slice(0, 3)
				: null,
			hasNimKey: Boolean(process.env.NVIDIA_NIM_API_KEY),
		};
		// Teste texto-only
		try {
			const t0 = Date.now();
			const r = await fetch(
				`https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-lite-latest:generateContent?key=${process.env.GEMINI_API_KEY}`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						contents: [
							{
								role: "user",
								parts: [{ text: "Responda apenas: ok" }],
							},
						],
						generationConfig: { maxOutputTokens: 10 },
					}),
					signal: AbortSignal.timeout(30_000),
				},
			);
			out.textTest = {
				status: r.status,
				ms: Date.now() - t0,
			};
		} catch (e: unknown) {
			out.textTest = { error: e instanceof Error ? e.message : String(e) };
		}
		// Teste com imagem: reproduz o fluxo real (composite + chamada)
		try {
			const idx = await fetch(
				"https://api.rainviewer.com/public/weather-maps.json",
				{ signal: AbortSignal.timeout(15_000) },
			).then((r) => r.json());
			const { buildRadarComposite } = await import(
				"../src/nowcast-vlm.js"
			);
			const { REGION_GRID, TARGET_IPIRANGA } = await import(
				"../src/nowcast-service.js"
			);
			const t1 = Date.now();
			const composite = await buildRadarComposite(
				idx.host,
				idx.radar?.past ?? [],
				REGION_GRID,
				{ target: TARGET_IPIRANGA },
			);
			out.composite = {
				ok: Boolean(composite),
				ms: Date.now() - t1,
				width: composite?.width,
				height: composite?.height,
				dataUrlLen: composite ? composite.dataUrl.length : 0,
			};
			if (composite) {
				const base64 = composite.dataUrl.replace(
					/^data:image\/png;base64,/,
					"",
				);
				const t2 = Date.now();
				const r = await fetch(
					`https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-lite-latest:generateContent?key=${process.env.GEMINI_API_KEY}`,
					{
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							contents: [
								{
									role: "user",
									parts: [
										{
											text: "Em 1 frase: o radar está limpo ao redor do pin IPIRANGA?",
										},
										{
											inline_data: {
												mime_type: "image/png",
												data: base64,
											},
										},
									],
								},
							],
							generationConfig: { maxOutputTokens: 50 },
						}),
						signal: AbortSignal.timeout(60_000),
					},
				);
				out.imageTest = {
					status: r.status,
					ms: Date.now() - t2,
					body: (await r.text()).slice(0, 300),
				};
			}
		} catch (e: unknown) {
			out.imageTest = {
				error: e instanceof Error ? e.message : String(e),
			};
		}
		if (res && typeof res.status === "function") {
			return res.status(200).json(out);
		}
		return Response.json(out);
	}

	try {
		await initDb();
		const config = loadConfig();
		const tracker = new EventTracker();
		await tracker.init();

		// Ciclo completo: clima + radar + nowcast (Camada A) + boletim NIM (Camada B),
		// em paralelo com os checks de serviços. O texto da Camada B é persistido no
		// Turso, então qualquer instância do /api/weather serve o texto atualizado.
		const [weatherState, data] = await Promise.all([
			syncWeatherCycle(),
			runAllChecks(config, tracker),
		]);

		for (const op of data.operators) {
			for (const r of op.portalResults) await savePortalResult(r);
			for (const r of op.connectivityResults) await saveConnectivityResult(r);
			await saveBgpResult(op.bgpResult);
		}

		for (const outage of data.newCopelOutages) {
			await sendCopelAlert(outage, config.telegramBotToken, config.telegramChatId);
			await saveEventLog(
				"copel",
				`Queda de Energia (${outage.ehProgramada ? "Programada" : "Emergencial"})`,
				outage.bairro || "Ipiranga",
				`Equipe: ${outage.statusEquipe || "Pendente"} | Previsão: ${outage.previsaoRestabelecimento || "Sem previsão"}`,
				outage.qtdConsumidores || 0,
			);
		}

		for (const intr of data.newSaneparInterruptions) {
			await sendSaneparAlert(intr, config.telegramBotToken, config.telegramChatId);
			await saveEventLog(
				"sanepar",
				`Interrupção de Água - ${intr.motivo || "Manutenção"}`,
				intr.bairro || intr.cidade || "Ipiranga",
				`Início: ${intr.inicio} | Fim: ${intr.fim}`,
				0,
			);
		}

		const result = {
			status: "ok",
			timestamp: Date.now(),
			weather: {
				tempC: weatherState.tempC,
				condition: weatherState.condition,
				hasRegionalRain: weatherState.hasRegionalRain,
			},
			nowcastBulletin: weatherState.nowcastBulletin
				? {
						generatedAt: weatherState.nowcastBulletin.generatedAt,
						source: weatherState.nowcastBulletin.source,
					}
				: null,
			checks: {
				operators: data.operators.length,
				newCopel: data.newCopelOutages.length,
				newSanepar: data.newSaneparInterruptions.length,
			},
		};

		if (res && typeof res.status === "function") {
			return res.status(200).json(result);
		}
		return Response.json(result);
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		if (res && typeof res.status === "function") {
			return res.status(500).json({ error: msg, timestamp: Date.now() });
		}
		return Response.json({ error: msg, timestamp: Date.now() }, { status: 500 });
	}
}
