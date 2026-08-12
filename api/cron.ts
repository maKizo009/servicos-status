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
