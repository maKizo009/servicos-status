import type { OperatorConfig, OperatorName } from "./types"

export interface AppConfig {
  telegramBotToken: string
  telegramChatId: string
  checkIntervalMs: number
  portalTimeoutMs: number
  connectivityTimeoutMs: number
  bgpTimeoutMs: number
  httpPort: number
  latencyOkMs: number
  latencyWarnMs: number
  lossOk: number
  lossWarn: number
  operators: Record<OperatorName, OperatorConfig>
}

export const connectivityTargets: { host: string; label: string }[] = [
  { host: "google.com", label: "Google" },
  { host: "cloudflare.com", label: "Cloudflare" },
  { host: "1.1.1.1", label: "Cloudflare DNS" },
]

function envInt(key: string, fallback: number): number {
  const v = process.env[key]
  if (v === undefined || v === "") return fallback
  const n = Number.parseInt(v, 10)
  return Number.isNaN(n) ? fallback : n
}

export function loadConfig(): AppConfig {
  return {
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN ?? "",
    telegramChatId: process.env.TELEGRAM_CHAT_ID ?? "",
    checkIntervalMs: envInt("CHECK_INTERVAL_MS", 60_000),
    portalTimeoutMs: envInt("PORTAL_TIMEOUT_MS", 10_000),
    connectivityTimeoutMs: envInt("CONNECTIVITY_TIMEOUT_MS", 5_000),
    bgpTimeoutMs: envInt("BGP_TIMEOUT_MS", 15_000),
    httpPort: envInt("HTTP_PORT", 3000),
    latencyOkMs: envInt("LATENCY_OK_MS", 500),
    latencyWarnMs: envInt("LATENCY_WARN_MS", 2000),
    lossOk: envInt("LOSS_OK", 0),
    lossWarn: envInt("LOSS_WARN", 10),
    operators: {
      Claro: { asn: 28573, portals: ["minhaclaro.claro.com.br"] },
      Vivo: { asn: 27699, portals: ["meuvivo.vivo.com.br"] },
      TIM: { asn: 26615, portals: ["meutim.tim.com.br"] },
    },
  }
}