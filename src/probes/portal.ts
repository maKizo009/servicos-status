import type { PortalResult, OperatorName } from "../types"

export async function checkPortal(
  host: string,
  operator: OperatorName,
  timeoutMs: number,
): Promise<PortalResult> {
  const start = performance.now()
  const timestamp = Date.now()

  try {
    const response = await fetch(`https://${host}`, {
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "follow",
    })
    const latencyMs = performance.now() - start
    return {
      operator,
      host,
      success: response.status < 500,
      latencyMs,
      error: "",
      timestamp,
    }
  } catch (err: unknown) {
    const latencyMs = performance.now() - start
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes("SSL") || msg.includes("certificate")) {
      try {
        const response = await fetch(`http://${host}`, {
          signal: AbortSignal.timeout(timeoutMs),
          redirect: "follow",
        })
        const retryLatency = performance.now() - start
        return {
          operator,
          host,
          success: response.status < 500,
          latencyMs: retryLatency,
          error: "",
          timestamp,
        }
      } catch {
        return { operator, host, success: false, latencyMs, error: `SSL fallback failed: ${msg}`, timestamp }
      }
    }
    if (msg.includes("dns") || msg.includes("getaddrinfo") || msg.includes("ENOTFOUND")) {
      return { operator, host, success: false, latencyMs: 0, error: `DNS fail: ${msg}`, timestamp }
    }
    if (msg.includes("timeout") || msg.includes("timed out")) {
      return { operator, host, success: false, latencyMs: timeoutMs, error: "Timeout", timestamp }
    }
    return { operator, host, success: false, latencyMs, error: msg, timestamp }
  }
}