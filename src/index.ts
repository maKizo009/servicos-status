import { loadConfig, connectivityTargets } from "./config"
import { logger } from "./logger"
import { initDb, savePortalResult, saveConnectivityResult, saveBgpResult, getLatestPortalResults, getLatestConnectivityResults, getLatestBgpResults, getPortalHistory, closeDb } from "./db"
import { sendTelegramAlert } from "./telegram"
import type { CheckResult, OperatorName, PortalResult, ConnectivityResult, BgpResult, AlertLevel } from "./types"

const config = loadConfig()
const db = initDb()

let checkResults: Map<OperatorName, CheckResult> = new Map()
let lastResults: PortalResult[] = []
let lastConnectivity: ConnectivityResult[] = []
let lastBgp: BgpResult[] = []
let currentLevel: AlertLevel = "ok"

function assessLevel(portals: PortalResult[], connectivity: ConnectivityResult[], bgp: BgpResult | null): AlertLevel {
  const portalFailures = portals.filter((p) => !p.success).length
  const connFailures = connectivity.filter((c) => !c.success).length

  if (portalFailures > 0 || connFailures > 0 || (bgp && bgp.error)) return "critical"

  const highLatency = portals.some((p) => p.latencyMs > config.latencyWarnMs && p.success)
  if (highLatency) return "warn"

  return "ok"
}

function formatLatency(ms: number): string {
  return `${ms.toFixed(0)}ms`
}

async function runChecks(): Promise<void> {
  logger.info("Starting check cycle")

  const allPortalResults: PortalResult[] = []
  const allConnResults: ConnectivityResult[] = []
  const allBgpResults: BgpResult[] = []

  for (const [opName, opCfg] of Object.entries(config.operators) as [OperatorName, { asn: number; portals: string[] }][]) {
    const portalResults = await Promise.all(
      opCfg.portals.map(async (host) => {
        const start = performance.now()
        try {
          const response = await fetch(`https://${host}`, {
            signal: AbortSignal.timeout(config.portalTimeoutMs),
            redirect: "follow",
          })
          const latencyMs = performance.now() - start
          return { operator: opName, host, success: response.status < 500, latencyMs, error: "", timestamp: Date.now() } as PortalResult
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err)
          return { operator: opName, host, success: false, latencyMs: performance.now() - start, error: msg, timestamp: Date.now() } as PortalResult
        }
      }),
    )

    const connectivityResults = await Promise.all(
      connectivityTargets.map(async (t) => {
        const start = performance.now()
        try {
          const response = await fetch(`https://${t.host}`, {
            method: "HEAD",
            signal: AbortSignal.timeout(config.connectivityTimeoutMs),
          })
          return { label: t.label, host: t.host, success: response.status < 500, latencyMs: performance.now() - start, error: "", timestamp: Date.now() } as ConnectivityResult
        } catch (err: unknown) {
          return { label: t.label, host: t.host, success: false, latencyMs: performance.now() - start, error: err instanceof Error ? err.message : String(err), timestamp: Date.now() } as ConnectivityResult
        }
      }),
    )

    let bgpResult: BgpResult
    try {
      const url = `https://stat.ripe.net/data/announced-prefixes/data.json?resource=AS${opCfg.asn}`
      const res = await fetch(url, { signal: AbortSignal.timeout(config.bgpTimeoutMs) })
      const data = (await res.json()) as { data?: { prefixes?: { prefix: string }[] } }
      const prefixes = data?.data?.prefixes ?? []
      const v4 = prefixes.filter((p) => !p.prefix.includes(":"))
      bgpResult = { operator: opName, asn: opCfg.asn, prefixCountV4: v4.length, prefixCountV6: prefixes.length - v4.length, samplePrefixes: v4.slice(0, 10).map((p) => p.prefix), timestamp: Date.now() }
    } catch (err: unknown) {
      bgpResult = { operator: opName, asn: opCfg.asn, prefixCountV4: 0, prefixCountV6: 0, samplePrefixes: [], timestamp: Date.now(), error: err instanceof Error ? err.message : String(err) }
    }

    for (const r of portalResults) savePortalResult(r)
    for (const r of connectivityResults) saveConnectivityResult(r)
    saveBgpResult(bgpResult)

    allPortalResults.push(...portalResults)
    allConnResults.push(...connectivityResults)
    allBgpResults.push(bgpResult)

    const opLevel = assessLevel(portalResults, connectivityResults, bgpResult)
    checkResults.set(opName, {
      operator: opName,
      portalResults,
      connectivityResults,
      bgpResult,
      status: opLevel,
      timestamp: Date.now(),
    })
  }

  lastResults = allPortalResults
  lastConnectivity = allConnResults
  lastBgp = allBgpResults

  const newLevel = assessLevel(allPortalResults, allConnResults, allBgpResults[0] ?? null)
  if (newLevel !== currentLevel) {
    currentLevel = newLevel
    const failedOps = [...checkResults.entries()]
      .filter(([, r]) => r.status !== "ok")
      .map(([name]) => name)
    const summary = failedOps.length > 0
      ? `⚠️ Problemas em: ${failedOps.join(", ")}`
      : "✅ Todas as operadoras OK"

    await sendTelegramAlert({
      botToken: config.telegramBotToken,
      chatId: config.telegramChatId,
      level: newLevel,
      operatorResults: [...checkResults.entries()].map(([name, r]) => ({
        operator: name,
        status: r.status === "ok" ? "✅ Normal" : r.status === "warn" ? "⚠️ Atenção" : "❌ Crítico",
        portals: r.portalResults,
      })),
      summary,
    })
  }

  logger.info("Check cycle completed", {
    totalPortals: allPortalResults.length,
    portalsOk: allPortalResults.filter((r) => r.success).length,
    level: currentLevel,
  })
}

function handleHealth(): Response {
  const levelCounts = {
    critical: [...checkResults.values()].filter((r) => r.status === "critical").length,
    warn: [...checkResults.values()].filter((r) => r.status === "warn").length,
    ok: [...checkResults.values()].filter((r) => r.status === "ok").length,
  }
  const healthy = levelCounts.critical === 0 && levelCounts.warn === 0

  return Response.json({
    status: healthy ? "healthy" : "degraded",
    level: currentLevel,
    uptime: Math.floor((Date.now() - startTime) / 1000),
    operatorCount: checkResults.size,
    levels: levelCounts,
    lastCheck: lastResults.length > 0 ? lastResults[0].timestamp : null,
    timestamp: Date.now(),
  })
}

function handleStatus(): Response {
  const results = [...checkResults.entries()].map(([name, r]) => ({
    operator: name,
    status: r.status,
    portals: r.portalResults.map((p) => ({
      host: p.host,
      success: p.success,
      latencyMs: p.latencyMs,
      error: p.error,
    })),
    connectivity: r.connectivityResults.map((c) => ({
      label: c.label,
      success: c.success,
      latencyMs: c.latencyMs,
      error: c.error,
    })),
    bgp: r.bgpResult
      ? {
          asn: r.bgpResult.asn,
          prefixCountV4: r.bgpResult.prefixCountV4,
          prefixCountV6: r.bgpResult.prefixCountV6,
          samplePrefixes: r.bgpResult.samplePrefixes,
          error: r.bgpResult.error,
        }
      : null,
  }))

  return Response.json({
    level: currentLevel,
    operators: results,
    timestamp: Date.now(),
  })
}

function handleHistory(url: URL): Response {
  const operator = url.searchParams.get("operator")
  const limit = Math.min(Number(url.searchParams.get("limit")) || 100, 1000)

  if (operator) {
    const history = getPortalHistory(operator, limit)
    return Response.json({ operator, count: history.length, results: history })
  }

  return Response.json({
    portals: getLatestPortalResults(limit),
    connectivity: getLatestConnectivityResults(limit),
    bgp: getLatestBgpResults(limit),
  })
}

async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url)
  const path = url.pathname

  try {
    if (path === "/health" || path === "/health/") return handleHealth()
    if (path === "/api/status") return handleStatus()
    if (path === "/api/history") return handleHistory(url)
    if (path === "/api/operators") {
      return Response.json({ operators: Object.keys(config.operators) })
    }
    if (path === "/api/bgp") {
      return Response.json({ results: getLatestBgpResults(20) })
    }
    if (path === "/api/check" && req.method === "POST") {
      await runChecks()
      return Response.json({ status: "ok", timestamp: Date.now() })
    }

    return new Response("Not found", { status: 404 })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.error("API error", { path, error: msg })
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    })
  }
}

const startTime = Date.now()
let checkInterval: ReturnType<typeof setInterval> | null = null
let server: { stop: () => void } | null = null

async function main(): Promise<void> {
  logger.info("Starting services-health monitor", {
    operators: Object.keys(config.operators),
    checkIntervalMs: config.checkIntervalMs,
    httpPort: config.httpPort,
  })

  await runChecks()

  checkInterval = setInterval(runChecks, config.checkIntervalMs)

  server = Bun.serve({
    port: config.httpPort,
    fetch: handleRequest,
  })

  logger.info(`HTTP server listening on :${config.httpPort}`)

  process.on("SIGTERM", gracefulShutdown)
  process.on("SIGINT", gracefulShutdown)
}

async function gracefulShutdown(): Promise<void> {
  logger.info("Shutting down gracefully...")

  if (checkInterval) clearInterval(checkInterval)
  if (server) server.stop()
  closeDb()

  logger.info("Shutdown complete")
  process.exit(0)
}

if (import.meta.path === Bun.main) {
  main().catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err)
    logger.error("Fatal error during startup", { error: msg })
    process.exit(1)
  })
}