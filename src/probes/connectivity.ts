import type { ConnectivityResult } from "../types"

export async function checkConnectivity(
  host: string,
  label: string,
  timeoutMs: number,
): Promise<ConnectivityResult> {
  const start = performance.now()
  const timestamp = Date.now()

  try {
    const response = await fetch(`https://${host}`, {
      method: "HEAD",
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "follow",
    })
    const latencyMs = performance.now() - start
    return {
      label,
      host,
      success: response.status < 500,
      latencyMs,
      error: "",
      timestamp,
    }
  } catch (err: unknown) {
    const latencyMs = performance.now() - start
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes("timeout") || msg.includes("timed out")) {
      return { label, host, success: false, latencyMs: timeoutMs, error: "Timeout", timestamp }
    }
    return { label, host, success: false, latencyMs, error: msg, timestamp }
  }
}