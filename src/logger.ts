import type { LogEntry } from "./types.js";

function writeLog(
	level: "info" | "warn" | "error",
	msg: string,
	meta?: Record<string, unknown>,
): void {
	const entry: LogEntry = {
		timestamp: new Date().toISOString(),
		...meta,
		level,
		message: msg,
	};
	const line = JSON.stringify(entry);
	if (level === "error") {
		console.error(line);
	} else {
		console.log(line);
	}
}

export const logger = {
	info(msg: string, meta?: Record<string, unknown>): void {
		writeLog("info", msg, meta);
	},
	warn(msg: string, meta?: Record<string, unknown>): void {
		writeLog("warn", msg, meta);
	},
	error(msg: string, meta?: Record<string, unknown>): void {
		writeLog("error", msg, meta);
	},
};
