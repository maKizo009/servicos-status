import type { NowcastResult } from "./radar-analysis.js";

export type OperatorName = "Claro" | "Vivo" | "TIM";

export interface OperatorConfig {
	asn: number;
	portals: string[];
}

export interface PortalResult {
	operator: OperatorName;
	host: string;
	success: boolean;
	latencyMs: number;
	error: string;
	timestamp: number;
}

export interface ConnectivityResult {
	label: string;
	host: string;
	success: boolean;
	latencyMs: number;
	error: string;
	timestamp: number;
}

export interface BgpResult {
	operator: OperatorName;
	asn: number;
	prefixCountV4: number;
	prefixCountV6: number;
	samplePrefixes: string[];
	timestamp: number;
	error?: string;
}

export interface LocalSignalReport {
	id?: number;
	operator: OperatorName;
	status: "ok" | "degraded" | "down";
	signalType: string;
	notes?: string;
	reportedAt: number;
	expiresAt: number;
}

export interface CheckResult {
	operator: OperatorName;
	portalResults: PortalResult[];
	connectivityResults: ConnectivityResult[];
	bgpResult: BgpResult | null;
	status: "ok" | "warn" | "critical";
	timestamp: number;
}

export type AlertLevel = "ok" | "warn" | "critical";

export interface LogEntry {
	level: "info" | "warn" | "error";
	message: string;
	timestamp: string;
	[key: string]: unknown;
}

// =================== COPEL ===================
export interface CopelOutage {
	idOcorrencia: string;
	numeroSequencial: string;
	municipio: string;
	bairro: string;
	ehProgramada: boolean;
	tipoPrincipal: string;
	tipoEvento: string;
	dataInicio: string;
	previsaoRestabelecimento: string | null;
	faixaDuracao: string;
	statusEquipe: string;
	qtdConsumidores: number;
	equipeId: string;
}

// =================== Sanepar ===================
export interface SaneparInterruption {
	cidade: string;
	bairro: string;
	inicio: string;
	fim: string;
	motivo: string;
	link: string;
}

// =================== Serviços de Utilidade ===================
export type ServiceSource = OperatorName | "Copel" | "Sanepar";
export type ServiceCategory = "telecom" | "utility";

export interface ServiceHealth {
	name: ServiceSource;
	category: ServiceCategory;
	status: "ok" | "warn" | "critical";
	details: string;
	timestamp: number;
	data?: Record<string, unknown>;
}

export interface UnifiedReport {
	generatedAt: number;
	overallStatus: "ok" | "warn" | "critical";
	services: ServiceHealth[];
	newEvents: {
		copel: CopelOutage[];
		sanepar: SaneparInterruption[];
	};
}

// =================== RainViewer & Clima ===================
export interface RainViewerFrame {
	time: number;
	path: string;
}

export interface WeatherRadarData {
	host: string;
	version: string;
	generated: number;
	radar: {
		past: RainViewerFrame[];
		nowcast: RainViewerFrame[];
	};
	satellite: {
		infrared: RainViewerFrame[];
	};
	status: "ok" | "degraded" | "down";
	lastSuccessTime: number;
	hasRegionalRain?: boolean;
	error?: string;
}

export interface WeatherBulletin {
	id?: number;
	bulletin: string;
	source: "nvidia_nim" | "gemini" | "heuristic";
	generatedAt: number;
}

export interface HourlyForecastPoint {
	time: string;
	tempC: number;
	rainProbabilityPct: number;
	precipitationMm: number;
}

export interface WeatherState {
	municipio: string;
	tempC: number;
	condition: string;
	rainProbabilityPct: number;
	windKmh: number;
	humidityPct: number;
	hasRegionalRain: boolean;
	regionalRainAlert: string;
	hourlyForecast: HourlyForecastPoint[];
	radar: WeatherRadarData | null;
	bulletin: WeatherBulletin | null;
	/** Nowcast determinístico (Camada A) — núcleos + movimento do radar */
	nowcast?: NowcastResult | null;
	/** Boletim narrativo do nowcast (Camada B — VLM NIM ou heurística) */
	nowcastBulletin?: {
		text: string;
		source: "nvidia_nim_vision" | "heuristic";
		generatedAt: number;
	} | null;
	updatedAt: number;
}
