import type { AlertLevel, PortalResult } from "./types"
import { logger } from "./logger"

interface AlertPayload {
  botToken: string
  chatId: string
  level: AlertLevel
  operatorResults: {
    operator: string
    status: string
    portals: PortalResult[]
  }[]
  summary: string
}

function buildAlertText(payload: AlertPayload): string {
  const emoji: Record<AlertLevel, string> = { ok: "🟢", warn: "🟡", critical: "🔴" }
  const header = `${emoji[payload.level]} *Monitor de Conectividade - Ipiranga/PR*\n${payload.summary}\n`

  const body = payload.operatorResults
    .map((op) => {
      const portalLines = op.portals
        .map((p) => `  ${p.success ? "✅" : "❌"} ${p.host} - ${p.latencyMs.toFixed(0)}ms${p.error ? ` (${p.error})` : ""}`)
        .join("\n")
      return `*${op.operator}* (${op.status})\n${portalLines}`
    })
    .join("\n\n")

  return `${header}\n${body}\n\n🕐 ${new Date().toISOString()}`
}

export async function sendTelegramAlert(payload: AlertPayload): Promise<boolean> {
  if (!payload.botToken || !payload.chatId) {
    logger.warn("Telegram not configured")
    return false
  }

  try {
    const text = buildAlertText(payload)
    const url = `https://api.telegram.org/bot${payload.botToken}/sendMessage`
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: payload.chatId,
        text,
        parse_mode: "Markdown",
        disable_web_page_preview: true,
      }),
    })

    if (!response.ok) {
      const body = await response.text()
      logger.error("Telegram API error", { status: response.status, body })
      return false
    }

    logger.info("Telegram alert sent", { level: payload.level })
    return true
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.error("Telegram send failed", { error: msg })
    return false
  }
}