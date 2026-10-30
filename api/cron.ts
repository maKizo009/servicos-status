import { runAllChecks, buildUnifiedReport } from "../src/checker.js";
import { randomUUID } from "node:crypto";
import { loadConfig } from "../src/config.js";
import { formatCopelPrevisao } from "../src/copel-format.js";
import {
	initDb,
	getDbClient,
	saveEventLog,
} from "../src/db.js";
import { syncWeatherCycle } from "../src/index.js";
import { ensureInitialized } from "../src/runtime-state.js";
import {
	conteudoPushChuvaIminente,
	sendEventPush,
} from "../src/push.js";
import { EventTracker } from "../src/state.js";
import {
	derivarFontes,
	salvarSourceHealth,
} from "../src/source-health.js";
import {
	sendCopelAlert,
	sendSaneparAlert,
	sendTelegramAlert,
} from "../src/telegram.js";

export default async function handler(req: any, res: any) {
	let lockOwner: string | null = null;
	let completed = false;
	try {
		// ===== Auth do cron — SÓ Bearer do CRON_SECRET (pentest 26/09/2026) =====
		// ANTES: `x-vercel-cron: 1` valia como identidade (header que qualquer um
		// manda) e o rate limit que deveria segurar o abuso era por instância —
		// rajada paralela passava. Resultado: qualquer pessoa disparava o ciclo
		// completo (cota NIM/LLM + Telegram + push para os 45 inscritos).
		// AGORA: fail-closed. Sem CRON_SECRET o endpoint não roda; sem o Bearer
		// correto, 401. Os TRÊS disparadores mandam Bearer (cron-job.org job
		// 8237452, cron Hermes vigia e GitHub Actions) e o vercel.json não tem
		// cron nativo — nada dependia do header.
		const config = loadConfig();
		const headers = req?.headers ?? {};
		const auth = headers.authorization ?? headers.Authorization ?? "";
		const cronSecret = config.cronSecret;
		if (!cronSecret) {
			if (res && typeof res.status === "function") {
				return res.status(503).json({ error: "Serviço indisponível" });
			}
			return Response.json({ error: "Serviço indisponível" }, { status: 503 });
		}
		if (auth !== `Bearer ${cronSecret}`) {
			if (res && typeof res.status === "function") {
				return res.status(401).json({ error: "Não autorizado" });
			}
			return Response.json({ error: "Não autorizado" }, { status: 401 });
		}
		// IP confiável da plataforma (x-real-ip) e, na falta, o 1º hop do XFF.
		// Contador COMPARTILHADO: vale para todas as instâncias (o Map local não
		// segura rajada paralela — medido 26/09/2026).
		const ip = String(
			headers["x-real-ip"] ??
				String(headers["x-forwarded-for"] ?? "unknown").split(",")[0],
		).trim();
		const { checkRateLimitShared } = await import("../src/rate-limiter.js");
		const { allowed, retryAfter } = await checkRateLimitShared(ip, 2, "cron");
		if (!allowed) {
			if (res && typeof res.status === "function") {
				return res
					.status(429)
					.setHeader("Retry-After", String(retryAfter))
					.json({ error: "Too many requests", retryAfter });
			}
			return Response.json(
				{ error: "Too many requests", retryAfter },
				{ status: 429 },
			);
		}

		// Preparação leve antes da trava: disparos descartados não executam migrações.
		const db = await getDbClient();
		await db.execute(`CREATE TABLE IF NOT EXISTS cron_cycle_lock (
			id INTEGER PRIMARY KEY, owner TEXT NOT NULL, expires_at INTEGER NOT NULL,
			last_completed_at INTEGER NOT NULL DEFAULT 0
		)`);
		try { await db.execute("ALTER TABLE cron_cycle_lock ADD COLUMN last_completed_at INTEGER NOT NULL DEFAULT 0"); } catch { /* já migrado */ }
		// Uma trava compartilhada protege contra disparadores simultâneos. A
		// expiração permite recuperação mesmo se a função for interrompida.
		const owner = randomUUID();
		const now = Date.now();
		const lock = await db.execute({
			sql: `INSERT INTO cron_cycle_lock (id, owner, expires_at, last_completed_at) VALUES (1, ?, ?, 0)
			ON CONFLICT(id) DO UPDATE SET owner=excluded.owner, expires_at=excluded.expires_at
			WHERE cron_cycle_lock.expires_at <= ? AND cron_cycle_lock.last_completed_at <= ? RETURNING owner`,
			args: [owner, now + 120_000, now, now - 9 * 60_000],
		});
		if (!lock.rows.length) {
			const result = { status: "skipped", reason: "cycle already running or recently completed" };
			if (res && typeof res.status === "function") return res.status(200).json(result);
			return Response.json(result);
		}
		lockOwner = owner;
		await initDb();
		const tracker = new EventTracker();
		await tracker.init();
		await ensureInitialized(tracker);

		// Ciclo completo: clima + radar + nowcast (Camada A) + boletim NIM (Camada B),
		// em paralelo com os checks de serviços. O texto da Camada B é persistido no
		// Turso, então qualquer instância do /api/weather serve o texto atualizado.
		const [weatherState, data] = await Promise.all([
			syncWeatherCycle(),
			runAllChecks(config, tracker),
		]);
		try {
			const report = await buildUnifiedReport(data, config.copelTotalConsumersCity);
			await db.execute("CREATE TABLE IF NOT EXISTS services_snapshot (id INTEGER PRIMARY KEY, payload TEXT NOT NULL)");
			await db.execute({ sql: "INSERT OR REPLACE INTO services_snapshot (id, payload) VALUES (1, ?)", args: [JSON.stringify(report)] });
		} catch (error) { console.error("Falha ao salvar serviços", error); }

		// Heartbeat por fonte (meta-monitoria, 30/09/2026): o ciclo completo é o
		// único lugar que vê TODAS as fontes de uma vez — grava o que cada uma
		// entregou no Turso (tabela source_health). É o que o /health expõe e o
		// que o vigia externo usa para avisar "fonte X parou". Nunca derruba o ciclo.
		try {
			await salvarSourceHealth(derivarFontes(weatherState, data));
		} catch (err) {
			console.error("Heartbeat de fontes falhou (não crítico):", String(err));
		}

		// Livro de apostas (Plano 2): registra o que o monitor está AFIRMANDO e
		// fecha o que já tem desfecho. Nunca derruba o ciclo (módulo não lança).
		try {
			const { registrarMedicaoChuva, registrarPrevisoesDoCiclo, reconciliarFechamentosCopel } =
				await import("../src/previsoes.js");
			await registrarMedicaoChuva(weatherState.cemaden);
			await registrarPrevisoesDoCiclo(weatherState, data);
			await reconciliarFechamentosCopel(
				data.copelOutages,
				data.copelConsultaOk !== false,
			);
		} catch (err) {
			console.error("Livro de apostas falhou (não crítico):", String(err));
		}

		for (const outage of data.newCopelOutages) {
			await sendCopelAlert(
				outage,
				config.telegramBotToken,
				config.telegramChatId,
			);
			await sendEventPush(
				"copel",
				`⚡ Queda de energia em ${outage.bairro || "Ipiranga"} (COPEL)`,
				`${outage.qtdConsumidores || 0} consumidores afetados | Previsão: ${formatCopelPrevisao(outage)}`,
			);
			await saveEventLog(
				"copel",
				`Queda de Energia (${outage.ehProgramada ? "Programada" : "Emergencial"})`,
				outage.bairro || "Ipiranga",
				`Equipe: ${outage.statusEquipe || "Pendente"} | Previsão: ${formatCopelPrevisao(outage)}`,
				outage.qtdConsumidores || 0,
			);
		}

		for (const intr of data.newSaneparInterruptions) {
			await sendSaneparAlert(
				intr,
				config.telegramBotToken,
				config.telegramChatId,
			);
			await sendEventPush(
				"sanepar",
				`🚱 Falta de água em ${intr.bairro || intr.cidade || "Ipiranga"} (Sanepar)`,
				intr.motivo || "Manutenção na rede de abastecimento",
			);
			await saveEventLog(
				"sanepar",
				`Interrupção de Água - ${intr.motivo || "Manutenção"}`,
				intr.bairro || intr.cidade || "Ipiranga",
				`Início: ${intr.inicio} | Fim: ${intr.fim}`,
				0,
			);
		}

		// Alerta de TEMPORAL iminente (Camada A: zona "alert" ≤80km/ETA≤2h).
		// Só NÚCLEO de tempestade (heavy/extreme) interrompe o celular: uma ÁREA de
		// chuva moderada é vigilância (amarelo) e não vira push. A notificação
		// incoerente de 27/09/2026 ("⛈️ Alerta de tempestade" com corpo de "chuva
		// moderada a ~39 km") nasceu daqui: disparava com qualquer `alertLevel ===
		// "alert"`, sem olhar o tipo/severidade da entidade.
		// Um push por evento: quando o alerta unificado já está laranja/vermelho,
		// ele manda o push do mesmo núcleo — aqui não se duplica.
		const nivelUnificado = weatherState.alertaUnificado?.nivel;
		const unificadoJaAvisa =
			nivelUnificado === "laranja" || nivelUnificado === "vermelho";
		// Só interrompe o celular com evidência CONFIRMADA entre ciclos
		// (29/09/2026): `radarSevero` sozinho promovia push por um único ciclo de
		// um núcleo no piso da faixa "forte" já enfraquecendo.
		const conteudoTemporal = unificadoJaAvisa
			? null
			: conteudoPushChuvaIminente({
					radarSevero: weatherState.radarSeveroConfirmado === true,
					textoRadar: weatherState.regionalRainAlert ?? null,
				});
		if (conteudoTemporal) {
			const enviado = await sendEventPush(
				"temporal",
				conteudoTemporal.titulo,
				conteudoTemporal.corpo,
				60 * 60_000,
			);
			if (enviado) {
				await sendTelegramAlert({
					botToken: config.telegramBotToken,
					chatId: config.telegramChatId,
					level: "critical",
					summary: conteudoTemporal.corpo,
				});
			}
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
				newCopel: data.newCopelOutages.length,
				newSanepar: data.newSaneparInterruptions.length,
			},
		};

		completed = true;
		if (res && typeof res.status === "function") {
			return res.status(200).json(result);
		}
		return Response.json(result);
	} catch (err: unknown) {
		// Detalhe só no log: `err.message` devolvia mensagem de driver/LLM ao
		// cliente (achado pentest 26/09/2026).
		console.error(
			"Cron handler error:",
			err instanceof Error ? err.stack ?? err.message : err,
		);
		if (res && typeof res.status === "function") {
			return res
				.status(500)
				.json({ error: "Erro interno", timestamp: Date.now() });
		}
		return Response.json(
			{ error: "Erro interno", timestamp: Date.now() },
			{ status: 500 },
		);
	} finally {
		if (lockOwner) {
			try {
				const db = await getDbClient();
				await db.execute({
						sql: completed
							? "UPDATE cron_cycle_lock SET expires_at = ?, last_completed_at = ? WHERE id = 1 AND owner = ?"
						: "DELETE FROM cron_cycle_lock WHERE id = 1 AND owner = ?",
						args: completed ? [Date.now() + 120_000, Date.now(), lockOwner] : [lockOwner],
				});
			} catch (error) { console.error("Falha ao liberar trava do cron", error); }
		}
	}
}
