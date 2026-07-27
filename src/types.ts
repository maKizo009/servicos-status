export type OperatorName = "Claro" | "Vivo" | "TIM"

export interface OperatorConfig {
  asn: number
  portals: string[]
}

export interface PortalResult {
  operator: OperatorName
  host: string
  success: boolean
  latencyMs: number
  error: string
  timestamp: number
}

export interface ConnectivityResult {
  label: string
  host: string
  success: boolean
  latencyMs: number
  error: string
  timestamp: number
}

export interface BgpResult {
  operator: OperatorName
  asn: number
  prefixCountV4: number
  prefixCountV6: number
  samplePrefixes: string[]
  timestamp: number
  error?: string
}

export interface CheckResult {
  operator: OperatorName
  portalResults: PortalResult[]
  connectivityResults: ConnectivityResult[]
  bgpResult: BgpResult | null
  status: "ok" | "warn" | "critical"
  timestamp: number
}

export type AlertLevel = "ok" | "warn" | "critical"

export interface LogEntry {
  level: "info" | "warn" | "error"
  message: string
  timestamp: string
  [key: string]: unknown
}