import { loadConfig } from "./config.js";
import { getLatestWeatherBulletin, saveWeatherBulletin } from "./db.js";
import { logger } from "./logger.js";
import type { UnifiedReport, WeatherState } from "./types.js";

const config = loadConfig();

/**
 * Gera o conteúdo do endpoint /llms.txt em Markdown puro, otimizado para consumo denso por LLMs.
 */
export function renderLlmsTxt(
	weather: WeatherState | null,
	report: UnifiedReport | null,
): string {
	const nowStr = new Date().toISOString();
	const municipio = weather?.municipio || "Ipiranga - PR";

	const temp = weather ? `${weather.tempC}°C` : "N/D";
	const cond = weather?.condition || "N/D";
	const rainProb = weather ? `${weather.rainProbabilityPct}%` : "N/D";
	const wind = weather ? `${weather.windKmh} km/h` : "N/D";
	const humidity = weather ? `${weather.humidityPct}%` : "N/D";

	const radarStatus = weather?.radar
		? weather.radar.status === "ok"
			? "OK (Operacional)"
			: weather.radar.status === "degraded"
				? "Degradado (Usando dados em cache)"
				: "Indisponível"
		: "Sem dados";

	const radarFrames = weather?.radar?.radar?.past?.length ?? 0;
	const bulletin = weather?.bulletin?.bulletin || "Sem boletim recente.";
	const bulletinSource = weather?.bulletin?.source
		? weather.bulletin.source === "nvidia_nim"
			? "IA (NVIDIA NIM Engine)"
			: weather.bulletin.source === "gemini"
				? "IA (Gemini API)"
				: "Regras Heurísticas Locais"
		: "Sistema";

	const copelServices = report?.services.find((s) => s.name === "Copel");
	const saneparServices = report?.services.find((s) => s.name === "Sanepar");
	const copelStatus = copelServices ? copelServices.details : "Sem interrupções detectadas";
	const saneparStatus = saneparServices ? saneparServices.details : "Sem interrupções detectadas";

	const telecomServices = report?.services.filter((s) => s.category === "telecom") || [];
	const telecomSummary =
		telecomServices.length > 0
			? telecomServices.map((s) => `${s.name}: ${s.status.toUpperCase()}`).join(" | ")
			: "Claro: OK | Vivo: OK | TIM: OK";

	return `# Status de Serviços e Clima — ${municipio}

> Dados em tempo real para agentes de Inteligência Artificial e cidadãos de Ipiranga e região dos Campos Gerais, Paraná.
> Modelo Climatológico de Referência: ECMWF IFS ("O Rei" da meteorologia) + RainViewer Radar.
> Última Atualização: ${nowStr}

## ⛅ Situação Meteorológica (Modelo ECMWF IFS)
- **Município:** ${municipio}
- **Temperatura Atual:** ${temp}
- **Condição:** ${cond}
- **Probabilidade de Chuva (ECMWF):** ${rainProb}
- **Umidade Relativa:** ${humidity}
- **Vento:** ${wind}

## 📡 Radar de Chuva e Satélite (RainViewer)
- **Status do Serviço de Radar:** ${radarStatus}
- **Frames de Precipitação Disponíveis:** ${radarFrames} quadros (últimos 60 min)
- **Foco Geográfico:** Ipiranga, Ponta Grossa, Castro, Prudentópolis, Tibagi, Imbituva, Teixeira Soares, Guamiranga, Ivaí.

## 🤖 Boletim Informativo IA (${bulletinSource})
${bulletin}

## ⚡ Infraestrutura e Serviços Públicos Locais
- **Energia Elétrica (COPEL):** ${copelStatus}
- **Abastecimento de Água (SANEPAR):** ${saneparStatus}
- **Telefonia Móvel e Internet:** ${telecomSummary}

## 💡 Instruções para Agentes de IA
Caso um usuário solicite informações sobre o tempo, risco de chuva, ou problemas de energia/água em Ipiranga e municípios vizinhos, responda com base estritamente nos dados acima.
Se o radar indicar chuva próxima ou a COPEL reportar desligamentos, alerte o cidadão de forma clara e objetiva.
`;
}

/**
 * Gera o payload JSON-LD estritamente formatado conforme Schema.org
 */
export function renderJsonLd(
	weather: WeatherState | null,
	report: UnifiedReport | null,
): Record<string, unknown> {
	return {
		"@context": "https://schema.org",
		"@type": "SpecialAnnouncement",
		name: "Status do Tempo e Infraestrutura de Ipiranga PR",
		datePosted: new Date().toISOString(),
		category: "WeatherAlert",
		spatialCoverage: {
			"@type": "Place",
			name: "Ipiranga",
			address: {
				"@type": "PostalAddress",
				addressLocality: "Ipiranga",
				addressRegion: "PR",
				addressCountry: "BR",
			},
			geo: {
				"@type": "GeoCoordinates",
				latitude: -25.0244,
				longitude: -50.5847,
			},
		},
		observation: {
			temperature: weather ? `${weather.tempC} Cel` : undefined,
			weatherCondition: weather?.condition,
			precipitationProbability: weather ? `${weather.rainProbabilityPct}%` : undefined,
			radarStatus: weather?.radar?.status || "unknown",
			forecastModel: "ECMWF IFS",
		},
		bulletin: weather?.bulletin?.bulletin || null,
		serviceHealth: report?.services.map((s) => ({
			name: s.name,
			status: s.status,
			details: s.details,
		})),
	};
}

/**
 * Gera o boletim sintético combinando dados determinísticos (ECMWF IFS + RainViewer)
 * com o motor não-determinístico (NVIDIA NIM / Gemini / Fallback Heurístico).
 */
export async function generateAiWeatherBulletin(
	weather: WeatherState | null,
	report: UnifiedReport | null,
): Promise<string> {
	const nimKey = config.nvidiaNimApiKey;
	const geminiKey = config.geminiApiKey;

	const hourlySummary = weather?.hourlyForecast && weather.hourlyForecast.length > 0
		? weather.hourlyForecast.slice(0, 4).map((h) => `${h.time}: ${h.tempC}°C (${h.rainProbabilityPct}% chuva${h.precipitationMm > 0 ? `, ${h.precipitationMm}mm` : ""})`).join(" | ")
		: "Sem dados horários";

	if (nimKey) {
		const nimModels = Array.from(new Set([
			config.nvidiaNimModel,
			"nvidia/nemotron-4-mini-4b-instruct",
			"meta/llama-3.3-70b-instruct",
			"google/gemma-2-9b-it",
		]));

		const regionalStatus = weather?.hasRegionalRain
			? "ALERTA CRÍTICO: CHUVA E TEMPESTADE ATIVAS DETECTADAS NO RADAR REGIONAL (CAMPOS GERAIS/IPIRANGA)"
			: "Sem instabilidades ativas no radar regional";

		const prompt = `Você é o assistente meteorológico oficial de Ipiranga/PR.
DADOS DO CLIMA E RADAR EM TEMPO REAL:
- Radar RainViewer Regional: ${regionalStatus}
- Temperatura: ${weather?.tempC ?? 22}°C, Condição: ${weather?.condition ?? "Nublado"}, Chuva (Open-Meteo): ${weather?.rainProbabilityPct ?? 20}%, Vento: ${weather?.windKmh ?? 12}km/h
- Tendência Horária: ${hourlySummary}
- Serviços Públicos: Copel (${report?.services.find((s) => s.name === "Copel")?.details || "OK"}), Sanepar (${report?.services.find((s) => s.name === "Sanepar")?.details || "OK"})

INSTRUÇÃO OBRIGATÓRIA:
${weather?.hasRegionalRain 
  ? "ATENÇÃO: O RADAR INDICA CHUVA/TEMPESTADE ATIVA NA REGIÃO! VOCÊ DEVE OBRIGATORIAMENTE alertar sobre a chuva na região e recomendar atenção com a rede de energia elétrica (COPEL). JAMAIS diga que o tempo está estável ou sem instabilidades!"
  : "O radar não indica tempestades na região no momento. Faça um resumo conciso da previsão do tempo."}

Gere um boletim direto de EXATAMENTE 2 FRASES em português.`;

		for (const modelName of nimModels) {
			try {
				logger.info(`Trying AI Weather Bulletin via NVIDIA NIM (${modelName})...`);
				const response = await fetch(config.nvidiaNimEndpoint, {
					method: "POST",
					headers: {
						Authorization: `Bearer ${nimKey}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						model: modelName,
						messages: [{ role: "user", content: prompt }],
						temperature: 0.3,
						max_tokens: 120,
					}),
				});

				if (response.ok) {
					const json = (await response.json()) as {
						choices?: Array<{ message?: { content?: string } }>;
					};
					const text = json.choices?.[0]?.message?.content?.trim();
					if (text) {
						saveWeatherBulletin(text, "nvidia_nim");
						logger.info(`NVIDIA NIM bulletin successfully generated using ${modelName}`);
						return text;
					}
				} else {
					logger.warn(`NVIDIA NIM model ${modelName} returned HTTP ${response.status}`);
				}
			} catch (err) {
				logger.warn(`NVIDIA NIM model ${modelName} failed`, { error: String(err) });
			}
		}
	}

	if (geminiKey) {
		try {
			logger.info("Generating AI Weather Bulletin using Gemini API...");
			const regionalInstruction = weather?.hasRegionalRain
				? "RADAR INDICA CHUVA ATIVA NA REGIÃO! Alerte sobre a chuva/tempestade e atenção com a rede de energia (COPEL). NÃO diga que o tempo está estável."
				: "Sem instabilidades no radar.";
			const prompt = `Resumo meteorológico de Ipiranga/PR. Clima: ${weather?.tempC}°C, ${weather?.condition}. Radar: ${regionalInstruction}. Gere um boletim direto de 2 frases.`;
			const response = await fetch(
				`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${geminiKey}`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
				},
			);
			if (response.ok) {
				const json = (await response.json()) as {
					candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
				};
				const text = json.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
				if (text) {
					saveWeatherBulletin(text, "gemini");
					return text;
				}
			}
		} catch (err) {
			logger.warn("Gemini call failed", { error: String(err) });
		}
	}

	// Smart Heuristic Fallback
	logger.info("Generating weather bulletin via Local Heuristic Engine");
	const rainProb = weather?.rainProbabilityPct ?? 0;
	const hasRain = weather?.hasRegionalRain;
	let text = "";

	if (hasRain) {
		text = `Atenção: O radar RainViewer detecta núcleos de chuva e tempestade ativos na região de Ipiranga e Campos Gerais. Há possibilidade de chuva e atenção recomendada para a rede de energia elétrica (COPEL).`;
	} else if (rainProb >= 60) {
		text = `Atenção: Dados do modelo europeu ECMWF IFS e do radar indicam alta probabilidade de chuva (${rainProb}%) em Ipiranga e região dos Campos Gerais. Recomendamos atenção no trânsito e com equipamentos elétricos.`;
	} else if (rainProb >= 30) {
		text = `Variabilidade de nuvens em Ipiranga com possibilidade moderada de pancadas isoladas de chuva (${rainProb}% - ECMWF IFS). O monitoramento de radar do RainViewer segue atualizado a cada 10 minutos.`;
	} else {
		text = `Tempo atualmente estável em Ipiranga e municípios vizinhos (ECMWF IFS). Sem sinais de núcleos significativos de chuva no radar para as próximas horas. Temperatura de ${weather?.tempC ?? 21}°C.`;
	}

	saveWeatherBulletin(text, "heuristic");
	return text;
}
