import { renderLlmsInstructions, renderLlmsTxt } from "../src/llm-formatter.js";
import type { UnifiedReport, WeatherState } from "../src/types.js";

const weather: WeatherState = {
	municipio: "Ipiranga - PR",
	tempC: 24,
	condition: "Parcialmente Nublado",
	rainProbabilityPct: 30,
	windKmh: 12,
	humidityPct: 65,
	hasRegionalRain: false,
	regionalRainAlert: "Sem instabilidades ativas.",
	hourlyForecast: [],
	radar: {
		host: "x",
		version: "v2",
		generated: 0,
		radar: { past: [], nowcast: [] },
		satellite: { infrared: [] },
		status: "ok",
		lastSuccessTime: Date.now(),
	},
	bulletin: {
		bulletin: "Núcleo moderado se aproxima. **dado do VLM**",
		source: "nvidia_nim_vision",
		generatedAt: Date.now() - 120000,
	},
	updatedAt: Date.now() - 180000,
};

const report: UnifiedReport = {
	generatedAt: Date.now() - 60000,
	overallStatus: "warn",
	services: [
		{
			name: "Claro",
			category: "telecom",
			status: "warn",
			details: "Portal lento (>300ms)",
			timestamp: Date.now(),
		},
		{
			name: "Copel",
			category: "utility",
			status: "ok",
			details: "Sem ocorrências",
			timestamp: Date.now(),
		},
	],
	newEvents: { copel: [], sanepar: [] },
};

const txt = renderLlmsTxt(weather, report);
const instructions = renderLlmsInstructions();

const checks: Record<string, boolean> = {
	"sem 'Instruções para Agentes de IA' no llms.txt": !txt.includes(
		"Instruções para Agentes de IA",
	),
	"sem 'Regras de Uso para Agentes' no llms.txt": !txt.includes(
		"Regras de Uso para Agentes",
	),
	"link para /llms-instructions.txt presente": txt.includes(
		"/llms-instructions.txt",
	),
	"rótulo novo 'Portais de Autoatendimento'": txt.includes(
		"Portais de Autoatendimento (Claro/Vivo/TIM)",
	),
	"nota sobre portal ≠ sinal celular": txt.includes(
		"não a qualidade do sinal celular local",
	),
	"timestamp de geração da requisição": txt.includes(
		"Documento gerado nesta requisição às:",
	),
	"timestamp dos dados meteorológicos": txt.includes(
		"Dados meteorológicos de:",
	),
	"timestamp do relatório de serviços": txt.includes(
		"Relatório de serviços de:",
	),
	"instruções têm conteúdo no endpoint separado": instructions.includes(
		"Instruções para Agentes de IA",
	),
	"instruções mencionam que telecom ≠ sinal": instructions.includes(
		"NÃO sinal celular local",
	),
};

let ok = true;
for (const [name, pass] of Object.entries(checks)) {
	console.log(`${pass ? "OK" : "FALHOU"} ${name}`);
	if (!pass) ok = false;
}
console.log("\n--- HEADER DO DOCUMENTO ---");
console.log(txt.split("\n").slice(0, 8).join("\n"));
console.log("\n--- SEÇÃO TELECOM ---");
console.log(
	txt
		.split("\n")
		.filter((l) => l.includes("Portais") || l.includes("Nota:"))
		.join("\n"),
);
process.exit(ok ? 0 : 1);
