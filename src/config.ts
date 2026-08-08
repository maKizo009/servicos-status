import type { OperatorConfig, OperatorName } from "./types.js";

export interface AppConfig {
	telegramBotToken: string;
	telegramChatId: string;
	checkIntervalMs: number;
	portalTimeoutMs: number;
	connectivityTimeoutMs: number;
	bgpTimeoutMs: number;
	httpPort: number;
	latencyOkMs: number;
	latencyWarnMs: number;
	latencyCritMs: number;
	lossOk: number;
	lossWarn: number;
	operators: Record<OperatorName, OperatorConfig>;

	// Utilidades
	copelApiUrl: string;
	copelTimeoutMs: number;
	copelTotalConsumersCity: number;
	saneparViewsAjaxUrl: string;
	saneparPageUrl: string;
	saneparViewName: string;
	saneparDisplays: string[];
	// AI / LLM & Clima
	nvidiaNimApiKey: string;
	nvidiaNimModel: string;
	nvidiaNimEndpoint: string;
	geminiApiKey: string;
	weatherModel: string;
	municipio: string;
	unifiedReportIntervalMs: number;
	// Turso Cloud Database
	tursoDatabaseUrl: string;
	tursoAuthToken: string;
}

export const connectivityTargets: { host: string; label: string }[] = [
	{ host: "google.com", label: "Google" },
	{ host: "cloudflare.com", label: "Cloudflare" },
	{ host: "1.1.1.1", label: "Cloudflare DNS" },
];

function envInt(key: string, fallback: number): number {
	const v = process.env[key];
	if (v === undefined || v === "") return fallback;
	const n = Number.parseInt(v, 10);
	return Number.isNaN(n) ? fallback : n;
}

export function loadConfig(): AppConfig {
	return {
		telegramBotToken: process.env.TELEGRAM_BOT_TOKEN ?? "",
		telegramChatId: process.env.TELEGRAM_CHAT_ID ?? "",
		checkIntervalMs: envInt("CHECK_INTERVAL_MS", 60_000),
		portalTimeoutMs: envInt("PORTAL_TIMEOUT_MS", 10_000),
		connectivityTimeoutMs: envInt("CONNECTIVITY_TIMEOUT_MS", 5_000),
		bgpTimeoutMs: envInt("BGP_TIMEOUT_MS", 15_000),
		httpPort: envInt("HTTP_PORT", 3030),
		latencyOkMs: envInt("LATENCY_OK_MS", 100),
		latencyWarnMs: envInt("LATENCY_WARN_MS", 150),
		latencyCritMs: envInt("LATENCY_CRIT_MS", 300),
		lossOk: envInt("LOSS_OK", 0),
		lossWarn: envInt("LOSS_WARN", 10),
		operators: {
			Claro: { asn: 28573, portals: ["minhaclaro.claro.com.br"] },
			Vivo: { asn: 27699, portals: ["meuvivo.vivo.com.br"] },
			TIM: { asn: 26615, portals: ["meutim.tim.com.br"] },
		},
		copelApiUrl:
			process.env.COPEL_API_URL ??
			"https://cdn.copel.com/aneel-informacoes/api/portal/mapa_poligonos_data",
		copelTimeoutMs: envInt("COPEL_TIMEOUT_MS", 30_000),
		copelTotalConsumersCity: envInt("COPEL_TOTAL_CONSUMERS_CITY", 5200),
		saneparViewsAjaxUrl:
			process.env.SANEPAR_VIEWS_AJAX ?? "https://www.sanepar.com.br/views/ajax",
		saneparPageUrl:
			process.env.SANEPAR_PAGE_URL ??
			"https://www.sanepar.com.br/esta-sem-agua",
		saneparViewName:
			process.env.SANEPAR_VIEW_NAME ?? "notices_panel_supply_stop",
		saneparDisplays: ["supply_stop_desk", "supply_stop_mobile"],
		nvidiaNimApiKey: process.env.NVIDIA_NIM_API_KEY ?? "",
		nvidiaNimModel: process.env.NVIDIA_NIM_MODEL ?? "meta/llama-3.1-8b-instruct",
		nvidiaNimEndpoint:
			process.env.NVIDIA_NIM_ENDPOINT ??
			"https://integrate.api.nvidia.com/v1/chat/completions",
		geminiApiKey: process.env.GEMINI_API_KEY ?? "",
		weatherModel: process.env.WEATHER_MODEL ?? "ecmwf_ifs04",
		municipio: process.env.MUNICIPIO ?? "Ipiranga",
		unifiedReportIntervalMs: envInt("UNIFIED_REPORT_INTERVAL_MS", 3_600_000),
		tursoDatabaseUrl: process.env.TURSO_DATABASE_URL ?? "",
		tursoAuthToken: process.env.TURSO_AUTH_TOKEN ?? "",
	};
}
