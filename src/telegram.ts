import { logger } from "./logger";
import type {
	AlertLevel,
	CopelOutage,
	PortalResult,
	SaneparInterruption,
	UnifiedReport,
} from "./types";

interface AlertPayload {
	botToken: string;
	chatId: string;
	level: AlertLevel;
	operatorResults: {
		operator: string;
		status: string;
		portals: PortalResult[];
	}[];
	summary: string;
}

function buildAlertText(payload: AlertPayload): string {
	const emoji: Record<AlertLevel, string> = {
		ok: "🟢",
		warn: "🟡",
		critical: "🔴",
	};
	const header = `${emoji[payload.level]} *Monitor de Conectividade - Ipiranga/PR*\n${payload.summary}\n`;

	const body = payload.operatorResults
		.map((op) => {
			const portalLines = op.portals
				.map(
					(p) =>
						`  ${p.success ? "✅" : "❌"} ${p.host} - ${p.latencyMs.toFixed(0)}ms${p.error ? ` (${p.error})` : ""}`,
				)
				.join("\n");
			return `*${op.operator}* (${op.status})\n${portalLines}`;
		})
		.join("\n\n");

	return `${header}\n${body}\n\n🕐 ${new Date().toISOString()}`;
}

async function sendTelegramMessage(
	botToken: string,
	chatId: string,
	text: string,
	parseMode: "Markdown" | "HTML" | null = "Markdown",
): Promise<boolean> {
	if (!botToken || !chatId) {
		logger.warn("Telegram not configured");
		return false;
	}

	try {
		const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
		const body: Record<string, unknown> = {
			chat_id: chatId,
			text,
			disable_web_page_preview: true,
		};
		if (parseMode) body.parse_mode = parseMode;

		const response = await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});

		if (!response.ok) {
			const respBody = await response.text();
			// If parse mode error, retry without it
			if (parseMode && respBody.toLowerCase().includes("parse")) {
				return sendTelegramMessage(botToken, chatId, text, null);
			}
			logger.error("Telegram API error", {
				status: response.status,
				body: respBody,
			});
			return false;
		}

		return true;
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		logger.error("Telegram send failed", { error: msg });
		return false;
	}
}

export async function sendTelegramAlert(
	payload: AlertPayload,
): Promise<boolean> {
	const text = buildAlertText(payload);
	const ok = await sendTelegramMessage(payload.botToken, payload.chatId, text);
	if (ok) logger.info("Telegram alert sent", { level: payload.level });
	return ok;
}

export async function sendCopelAlert(
	outage: CopelOutage,
	botToken: string,
	chatId: string,
): Promise<boolean> {
	const tag = outage.ehProgramada
		? "⚡️ *DESLIGAMENTO PROGRAMADO*"
		: "🔴 *FALTA DE ENERGIA (Emergência)*";
	const previsao = outage.previsaoRestabelecimento || "Sem previsão";

	const text = `${tag} - IPIRANGA/PR

📍 *Local:* ${outage.bairro}, Ipiranga
🆔 *Ocorrência:* #${outage.numeroSequencial}
📅 *Início:* ${outage.dataInicio}
⏱️ *Duração estimada:* ${outage.faixaDuracao}
🔌 *Previsão de retorno:* ${previsao}
👥 *Consumidores afetados:* ${outage.qtdConsumidores}
📋 *Status:* ${outage.statusEquipe}
🏷️ *Tipo:* ${outage.tipoEvento}

_Source: COPEL ANEEL Informações_`;

	const ok = await sendTelegramMessage(botToken, chatId, text);
	if (ok) {
		logger.info("Copel alert sent", { sequencial: outage.numeroSequencial });
	}
	return ok;
}

export async function sendSaneparAlert(
	interruption: SaneparInterruption,
	botToken: string,
	chatId: string,
): Promise<boolean> {
	const text = `💧 *INTERRUPÇÃO DE ÁGUA PROGRAMADA* - IPIRANGA/PR

📍 *Local:* ${interruption.bairro}, ${interruption.cidade}
📅 *Início:* ${interruption.inicio}
🔚 *Previsão de normalização:* ${interruption.fim}
🔧 *Motivo:* ${interruption.motivo}
🔗 *Detalhes:* ${interruption.link}

_Source: Sanepar - Está sem água?_`;

	const ok = await sendTelegramMessage(botToken, chatId, text);
	if (ok) {
		logger.info("Sanepar alert sent", { bairro: interruption.bairro });
	}
	return ok;
}

export async function sendUnifiedReport(
	report: UnifiedReport,
	botToken: string,
	chatId: string,
): Promise<boolean> {
	const emojiMap: Record<string, string> = {
		ok: "🟢",
		warn: "🟡",
		critical: "🔴",
	};

	const lines: string[] = [];
	lines.push(`📊 *RELATÓRIO UNIFICADO - IPIRANGA/PR*`);
	lines.push(`🕐 ${new Date(report.generatedAt).toISOString()}\n`);

	const telecom = report.services.filter((s) => s.category === "telecom");
	const utilities = report.services.filter((s) => s.category === "utility");

	lines.push(`*📡 Operadoras*`);
	for (const s of telecom) {
		lines.push(`${emojiMap[s.status] || "⚪"} *${s.name}* — ${s.details}`);
	}

	lines.push(`\n*🔧 Utilidades*`);
	for (const s of utilities) {
		lines.push(`${emojiMap[s.status] || "⚪"} *${s.name}* — ${s.details}`);
	}

	lines.push(
		`\n*Status geral:* ${emojiMap[report.overallStatus]} ${report.overallStatus.toUpperCase()}`,
	);

	const text = lines.join("\n");
	const ok = await sendTelegramMessage(botToken, chatId, text);
	if (ok)
		logger.info("Unified report sent", { overallStatus: report.overallStatus });
	return ok;
}
