import { runAllChecks } from "../src/checker";
import { loadConfig } from "../src/config";
import {
	getDbClient,
	initDb,
	saveBgpResult,
	saveConnectivityResult,
	saveEventLog,
	savePortalResult,
} from "../src/db";
import { EventTracker } from "../src/state";
import { sendCopelAlert, sendSaneparAlert } from "../src/telegram";
import { fetchCurrentWeather, fetchRainViewerRadar, saveRadarCache } from "../src/weather-collector";

export default async function handler(req: Request): Promise<Response> {
	try {
		await initDb();
		const config = loadConfig();
		const tracker = new EventTracker();

		const [radar, weatherInfo, data] = await Promise.all([
			fetchRainViewerRadar(),
			fetchCurrentWeather(),
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

		return Response.json({
			status: "ok",
			timestamp: Date.now(),
			weather: {
				tempC: weatherInfo.tempC,
				condition: weatherInfo.condition,
				hasRegionalRain: radar.hasRegionalRain,
			},
			checks: {
				operators: data.operators.length,
				newCopel: data.newCopelOutages.length,
				newSanepar: data.newSaneparInterruptions.length,
			},
		});
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		return Response.json({ error: msg, timestamp: Date.now() }, { status: 500 });
	}
}
