import type { LogEntry } from "./types"

function writeLog(entry: LogEntry): void {
  const line = JSON.stringify(entry)
  if (entry.level === "error") {
    console.error(line)
  } else {
    console.log(line)
  }
}

export const logger = {
  info(msg: string, meta?: Record<string, unknown>): void {
    writeLog({ level: "info", message: msg, timestamp: new Date().toISOString(), ...meta })
  },
  warn(msg: string, meta?: Record<string, unknown>): void {
    writeLog({ level: "warn", message: msg, timestamp: new Date().toISOString(), ...meta })
  },
  error(msg: string, meta?: Record<string, unknown>): void {
    writeLog({ level: "error", message: msg, timestamp: new Date().toISOString(), ...meta })
  },
}