import { waitUntil } from "@vercel/functions";
import {
	buildAlertaUnificado,
	fetchAlertasOficiais,
	logAlertaUnificado,
} from "./alertas-oficiais.js";
import { fetchHidroTriangulacao } from "./ana-hidro.js";
import {
	fetchCemadenIpiranga,
	maxAcumuladoFresco,
	temEstacaoFresca,
} from "./cemaden.js";
import { buildUnifiedReport, runAllChecks } from "./checker.js";
import { loadConfig } from "./config.js";
import {
	closeDb,
	getDailyStatsSummary,
	getLatestNowcastBulletin,
	getLatestWeatherBulletin,
	getWeatherStateCache,
	initDb,
	saveEventLog,
	saveWeatherStateCache,
} from "./db.js";
import {
	renderJsonLd,
	renderLlmsInstructions,
	renderLlmsTxt,
} from "./llm-formatter.js";
import { logger } from "./logger.js";
import {
	ANALYSIS_SMOOTH,
	ANALYSIS_TILE_PX,
	getRadarNowcast,
} from "./nowcast-service.js";
import { fmtEta, formatRainEntityAlert } from "./radar-analysis.js";
import { checkRateLimit, checkRateLimitScope } from "./rate-limiter.js";
import {
	CIDADES_CORREDOR,
	cidadesComNucleo,
	fetchSigmaRede,
	resumoSolo,
	SIGMA_RAIO_CIDADE_KM,
	type SigmaResultado,
} from "./sigma-feed.js";
import { EventTracker } from "./state.js";
import {
	sendCopelAlert,
	sendSaneparAlert,
	sendUnifiedReport,
} from "./telegram.js";
import type {
	RainAlertLevel,
	UnifiedReport,
	WeatherState,
} from "./types.js";
import {
	fetchCurrentWeather,
	fetchRainViewerRadar,
	getCachedWeatherState,
	setCachedWeatherState,
} from "./weather-collector.js";

const config = loadConfig();
let isInitialized = false;
let tracker: EventTracker;

/** Origens permitidas no CORS (whitelist — nunca `*`). */
const ALLOWED_ORIGINS = new Set([
	"https://servicos-status.vercel.app",
	"https://os-status.vercel.app",
	"http://localhost:3030",
]);

export async function ensureInitialized(): Promise<void> {
	if (!isInitialized) {
		await initDb();
		tracker = new EventTracker();
		await tracker.init();
		isInitialized = true;
	}
}

let lastUnifiedReportTime = 0;
let lastUnifiedReport: UnifiedReport | null = null;

// Aqui viviam checkResults, lastResults, currentLevel, failureCounts e
// updateFailureCounts — o debounce de falhas (Achado 4) e o nível agregado das
// OPERADORAS. Removidos em 22/09/2026 junto com os probes de conectividade/BGP:
// sem eles o debounce não tem o que contar e `currentLevel` nunca mais mudaria
// (seria um "ok" mentiroso no log e no /health). O nível agora vem de
// lastUnifiedReport.overallStatus.

async function runChecks(): Promise<void> {
	await ensureInitialized();
	logger.info("Starting check cycle");

	const data = await runAllChecks(config, tracker);

	// Aqui rodava o ciclo das OPERADORAS: debounce de falhas, gravação de
	// conectividade/BGP no banco, nível agregado (assessLevel) e o alerta no
	// Telegram ("Todas as operadoras OK"). Removido em 22/09/2026 — os testes de
	// operadora/ISP saíram do produto e não geram mais dado.

	// Per-event alerts for COPEL
	for (const outage of data.newCopelOutages) {
		await sendCopelAlert(
			outage,
			config.telegramBotToken,
			config.telegramChatId,
		);
		await saveEventLog(
			"copel",
			`Queda de Energia (${outage.ehProgramada ? "Programada" : "Emergencial"})`,
			outage.bairro || "Ipiranga",
			`Equipe: ${outage.statusEquipe || "Pendente"} | Previsão: ${outage.previsaoRestabelecimento || "Sem previsão"}`,
			outage.qtdConsumidores || 0,
		);
	}

	// Per-event alerts for Sanepar
	for (const intr of data.newSaneparInterruptions) {
		await sendSaneparAlert(
			intr,
			config.telegramBotToken,
			config.telegramChatId,
		);
		await saveEventLog(
			"sanepar",
			`Interrupção de Água - ${intr.motivo || "Manutenção"}`,
			intr.bairro || intr.cidade || "Ipiranga",
			`Início: ${intr.inicio} | Fim: ${intr.fim}`,
			0,
		);
	}

	// Build and optionally send unified report
	lastUnifiedReport = await buildUnifiedReport(
		data,
		config.copelTotalConsumersCity,
	);
	const now = Date.now();
	if (
		config.unifiedReportIntervalMs > 0 &&
		now - lastUnifiedReportTime >= config.unifiedReportIntervalMs
	) {
		lastUnifiedReportTime = now;
		await sendUnifiedReport(
			lastUnifiedReport,
			config.telegramBotToken,
			config.telegramChatId,
		);
	}

	logger.info("Check cycle completed", {
		activeCopel: data.copelOutages.length,
		newCopel: data.newCopelOutages.length,
		activeSanepar: data.saneparInterruptions.length,
		newSanepar: data.newSaneparInterruptions.length,
		alertLevel: lastUnifiedReport?.overallStatus ?? "ok",
	});
}

function handleHealth(): Response {
	// ATENÇÃO: até 22/09/2026 este endpoint media o nível das OPERADORAS
	// (checkResults). Com a remoção da telefonia/ISP esse mapa ficou sempre
	// vazio e o /health responderia "healthy" para sempre — falha silenciosa
	// para qualquer monitor de uptime apontado nele. Agora reflete os serviços
	// monitorados de verdade (COPEL/Sanepar) pelo relatório unificado.
	const services = lastUnifiedReport?.services ?? [];
	const levelCounts = {
		critical: services.filter((s) => s.status === "critical").length,
		warn: services.filter((s) => s.status === "warn").length,
		ok: services.filter((s) => s.status === "ok").length,
	};
	// Sem relatório ainda (cold start) não é "saudável": é desconhecido.
	const healthy =
		services.length > 0 && levelCounts.critical === 0 && levelCounts.warn === 0;

	return Response.json({
		status: healthy ? "healthy" : "degraded",
		level: lastUnifiedReport?.overallStatus ?? "ok",
		uptime: Math.floor((Date.now() - startTime) / 1000),
		serviceCount: services.length,
		services: services.map((s) => ({ name: s.name, status: s.status })),
		levels: levelCounts,
		lastCheck: lastUnifiedReport?.generatedAt ?? null,
		timestamp: Date.now(),
	});
}

// handleStatus (/api/status) e handleHistory (/api/history) serviam só as
// operadoras: listavam conectividade/BGP por operadora e o histórico de
// medições. Removidos em 22/09/2026 com as rotas — os dados não são mais
// coletados, então os endpoints só poderiam devolver vazio.

function handleServices(): Response {
	if (!lastUnifiedReport) {
		return Response.json({ services: [], generatedAt: null });
	}
	return Response.json(lastUnifiedReport);
}

let weatherInterval: ReturnType<typeof setInterval> | null = null;

// O TTL do boletim narrativo agora vive em llm-bulletin.ts (avaliarReuso), junto
// com as checagens de medição/cenário. Havia um TTL separado aqui e as duas
// lógicas divergiram — o texto congelado passava pela checagem de fora.

/** Exportado para o /api/cron (api/cron.ts) rodar o ciclo completo de clima+radar+NIM. */
export async function syncWeatherCycle(): Promise<WeatherState> {
	await ensureInitialized();
	logger.info("Starting weather & radar sync cycle...");
	// Os avisos oficiais (INMET/Simepar/Defesa Civil) não dependem de nada do
	// ciclo e levam até 8 s: dispara JUNTO com o primeiro lote em vez de esperar
	// no fim. Era uma das chamadas em série que faziam o ciclo chegar a 26 s
	// (medido 22/09/2026) — o boletim já tinha saído do caminho crítico e o
	// tempo restante estava aqui. fetchAlertasOficiais nunca lança (timeout
	// curto interno), então iniciar cedo não cria rejeição solta.
	const promessaOficiais = fetchAlertasOficiais();
	const [radar, weatherInfo, cemaden] = await Promise.all([
		fetchRainViewerRadar(),
		fetchCurrentWeather(),
		fetchCemadenIpiranga(),
	]);

	// Triangulação hidro — mesmo ciclo (chuva CEMADEN alimenta IBR/IFL).
	// Só estações FRESCAS: pluviômetro parado não pode virar "sem chuva" aqui.
	const maxAcc = (f: (e: (typeof cemaden.estacoes)[number]) => number | null) =>
		maxAcumuladoFresco(cemaden.estacoes, f);
	// Radar é fonte única (RainViewer, tiles georreferenciados) para todos os
	// leitores: o mosaico JPEG do Simepar saiu em 23/09/2026 — vinha "assado"
	// (mapa + rótulos + radar no mesmo pixel) e, com o radar de Teixeira Soares
	// desativado, sobrava só Cascavel a ~400 km = feixe alto e resolução grossa.
	const hidro = await fetchHidroTriangulacao({
		p1h: maxAcc((e) => e.acc1hr),
		p6h: maxAcc((e) => e.acc6hr),
		p24h: maxAcc((e) => e.acc24hr),
		p72h: maxAcc((e) => e.acc72hr),
	});

	// Boletim da tabela legada (weather_bulletins, formato "NIM texto" que não
	// é mais gravado): só é usado se FRESCO (<60 min), senão a Camada B
	// (nowcastBulletin VLM/heurística) é a única fonte do boletim atual.
	const existingBulletin = await getLatestWeatherBulletin();
	const freshLegacyBulletin =
		existingBulletin && Date.now() - existingBulletin.generatedAt < 60 * 60_000
			? existingBulletin
			: null;

	const state: WeatherState = {
		municipio: config.municipio || "Ipiranga",
		tempC: weatherInfo.tempC,
		condition: weatherInfo.condition,
		rainProbabilityPct: weatherInfo.rainProbabilityPct,
		windKmh: weatherInfo.windKmh,
		humidityPct: weatherInfo.humidityPct,
		hasRegionalRain: radar.hasRegionalRain || false,
		regionalRainAlert: radar.hasRegionalRain
			? "🌩️ Núcleos de chuva detectados na região dos Campos Gerais. Atenção para potencial deslocamento de instabilidades e oscilações na rede elétrica (COPEL)."
			: "Sem instabilidades ativas no radar regional.",
		hourlyForecast: weatherInfo.hourlyForecast || [],
		radar,
		bulletin: freshLegacyBulletin,
		cemaden,
		hidro,
		updatedAt: Date.now(),
	};

	setCachedWeatherState(state);

	// Nowcast determinístico (Camada A): analisa núcleos + movimento do radar
	try {
		const nowcast = await getRadarNowcast();
		state.nowcast = nowcast;
		// FONTE DA VERDADE: o alerta regional (card COPEL, dashboard) passa a
		// ser dirigido pelos GATES DE RELEVÂNCIA (distância + ETA + direção),
		// não pela intensidade bruta do frame. Incidente 2026-08-12: núcleo
		// extreme a 589 km (RS) acendia "Alerta de Tempestade" com o mapa
		// limpo no PR. Agora só a zona IMINENTE (≤80 km, ETA ≤120 min)
		// liga o card; vigilância (≤200 km, ETA ≤360 min) informa sem alertar.
		if (nowcast.currentDominant === "none" || nowcast.frames.length === 0) {
			state.hasRegionalRain = false;
			state.alertLevel = "none";
			state.nearestThreatKm = null;
			state.regionalRainAlert =
				"Sem instabilidades ativas no radar regional (análise determinística de núcleos).";
		} else {
			const intensityLabel: Record<string, string> = {
				light: "fraca",
				moderate: "moderada",
				heavy: "forte",
				extreme: "muito forte (temporal)",
			};
			const m = nowcast.movement;
			// Núcleos por zona de relevância (Camada A). threats já vem
			// ordenado por perigo (aproximando com menor ETA primeiro).
			const nearestAlert =
				nowcast.threats.find((t) => t.relevanceZone === "alert") ?? null;
			const nearestWatch =
				nowcast.threats.find((t) => t.relevanceZone === "watch") ?? null;
			const topThreat = nowcast.threats[0] ?? null;
			const alertLevel: RainAlertLevel = nearestAlert
				? "alert"
				: nearestWatch
					? "watch"
					: "monitor";
			state.alertLevel = alertLevel;
			state.nearestThreatKm = topThreat
				? Math.round(topThreat.distToTargetKm)
				: null;

			state.hasRegionalRain = alertLevel === "alert";
			// SEVERIDADE (push) ≠ RELEVÂNCIA (site). Área de chuva moderada é
			// relevante para o card e irrelevante para interromper o celular
			// (regra do dono 21/09/2026: "alertas só em casos realmente
			// importantes"). Só núcleo de tempestade na zona de alerta promove.
			const entidadeSevera =
				nearestAlert &&
				nearestAlert.kind === "nucleo" &&
				(nearestAlert.intensity === "heavy" ||
					nearestAlert.intensity === "extreme");
			state.radarSevero = Boolean(entidadeSevera);
			state.radarKind = (nearestAlert ?? nearestWatch)?.kind ?? null;
			if (alertLevel === "monitor") {
				state.regionalRainAlert = `ℹ️ Monitoramento: atividade de radar detectada a ${topThreat ? `~${Math.round(topThreat.distToTargetKm)} km` : "grande distância"} de Ipiranga. Sem risco iminente no momento.`;
			} else {
				// Área de chuva (moderada) x núcleo (tempestade): o texto muda, o gate
				// não. Texto montado em formatRainEntityAlert (testável).
				const t = alertLevel === "alert" ? nearestAlert : nearestWatch;
				state.regionalRainAlert = t
					? formatRainEntityAlert({
							level: alertLevel,
							kind: t.kind,
							intensity: t.intensity,
							distKm: t.distToTargetKm,
							approach: t.threat?.approach ?? null,
							etaMin: t.threat?.etaMin ?? null,
						})
					: `ℹ️ Monitoramento: sem chuva relevante no radar a caminho de Ipiranga.`;
			}
		}
		// ── Solo sob demanda (regra do Dave 21/09/2026) ─────────────────────
		// Só consultamos o feed do Sigma quando há NÚCLEO DE CHUVA perto de uma
		// cidade do corredor — é quando dado de solo muda a severidade (rajada,
		// queda de pressão, acumulado). Sem núcleo perto: ZERO requisições.
		// Ordem: WU (mais densa, rajada+pressão, ~5 min) → SIMEPAR → INMET,
		// parando assim que cobrir todas as cidades quentes.
		try {
			const quentes = cidadesComNucleo(
				nowcast.threats.map((t) => ({ lat: t.lat, lon: t.lon })),
				[...CIDADES_CORREDOR],
				SIGMA_RAIO_CIDADE_KM,
			);
			if (quentes.length === 0) {
				state.soloCidades = null;
			} else {
				const porRede: SigmaResultado[] = await Promise.all(
					(["wu", "simepar", "inmet"] as const).map((rede) => fetchSigmaRede(rede)),
				);
				// Antes isto era um `for` em série com `break` de economia de
				// requisição: cada rede podia gastar o timeout inteiro e o pior caso
				// chegava a 24 s — o maior resto de tempo do ciclo depois que o
				// boletim saiu do caminho crítico (22/09/2026). Pedir as três custa
				// pouco e o ganho de tempo é grande quando as três estão lentas.
				state.soloCidades = resumoSolo(quentes, porRede, SIGMA_RAIO_CIDADE_KM);
				logger.info("Sigma: solo sob demanda consultado", {
					cidades: quentes.map((c) => c.nome).join(", "),
					redes: porRede.map((r) => `${r.rede}=${r.estacoes.length}`).join(" "),
					noResumo: state.soloCidades.length,
				});
			}
		} catch (err) {
			// Fonte auxiliar: falha dela NUNCA bloqueia o ciclo.
			logger.warn("Sigma feed falhou (auxiliar, não bloqueia)", {
				error: String(err),
			});
			state.soloCidades = null;
		}
		setCachedWeatherState(state);
		logger.info("Nowcast integrado ao estado de clima", {
			dominant: nowcast.currentDominant,
			maxDbz: nowcast.currentMaxDbz,
			alertLevel: state.alertLevel,
			nearestThreatKm: state.nearestThreatKm,
			threatsAlert: nowcast.threats.filter((t) => t.relevanceZone === "alert")
				.length,
			threatsWatch: nowcast.threats.filter((t) => t.relevanceZone === "watch")
				.length,
			threatsMonitor: nowcast.threats.filter(
				(t) => t.relevanceZone === "monitor",
			).length,
			movement: nowcast.movement
				? `${nowcast.movement.directionDeg}° ${nowcast.movement.speedKmh}km/h`
				: null,
		});

		// Camada B: boletim narrativo (LLM analista → heurística).
		// UM gate de reuso só (avaliarReuso, em llm-bulletin.js): compara a MEDIÇÃO e
		// a impressão do cenário, não só a idade. Havia duas lógicas de cache aqui e
		// elas divergiram — a de fora só olhava tempo + coerência com o radar, então
		// "chove agora" com pluviômetro zerado era servido de novo a cada ciclo
		// (incidente do Boletim IA, 22/09/2026).
		if (state.radar) {
			const {
				avaliarReuso,
				buildAnalystContext,
				chaveDoCenario,
				generateSmartBulletin,
			} = await import("./llm-bulletin.js");
			const ests = state.cemaden?.estacoes ?? [];
			const maxAcc = (f: (e: (typeof ests)[number]) => number | null) =>
				maxAcumuladoFresco(ests, f);
			const localCtx = {
				acc1hrMax: maxAcc((e) => e.acc1hr),
				acc6hrMax: maxAcc((e) => e.acc6hr),
				acc24hrMax: maxAcc((e) => e.acc24hr),
				condition: weatherInfo.condition,
			};
			const ecmwfCtx = {
				rainProbabilityPct: weatherInfo.rainProbabilityPct,
				hourlyForecast: weatherInfo.hourlyForecast || [],
			};
			const relevance = {
				alertLevel: state.alertLevel ?? "monitor",
				nearestThreatKm: state.nearestThreatKm ?? null,
			} as const;
			const prox6h = (weatherInfo.hourlyForecast || [])
				.slice(0, 6)
				.reduce((s, h) => s + (h.precipitationMm ?? 0), 0);
			const built = buildAnalystContext(nowcast, {
				local: localCtx,
				condition: weatherInfo.condition,
				ecmwfPct: weatherInfo.rainProbabilityPct,
				ecmwfProx6hMm: prox6h,
				alertLevel: state.alertLevel ?? "monitor",
				hidroWatch: state.hidro?.riscoCheia === "watch",
				avisosOficiais: (state.alertasOficiais?.avisos ?? []).map(
					(a) => `${a.fonte}: ${a.titulo}`,
				),
				solo: state.soloCidades ?? [],
			});

			const cachedBulletin = await getLatestNowcastBulletin();
			const aval = avaliarReuso({
				cached: cachedBulletin,
				local: localCtx,
				nowcast,
				chaveCenario: chaveDoCenario(built.analyst),
			});
			if (aval.reusar && cachedBulletin) {
				state.nowcastBulletin = cachedBulletin;
				logger.info("Boletim nowcast reutilizado do cache persistido", {
					ageMin: Math.round((Date.now() - cachedBulletin.generatedAt) / 60000),
					source: cachedBulletin.source,
					motivo: aval.motivo,
				});
			} else if (cachedBulletin) {
				logger.info("Boletim nowcast stale no cache, regenerando", {
					motivo: aval.motivo,
				});
			}
			if (!state.nowcastBulletin) {
				// GATE DE CRÉDITO (Dave, 21/09/2026): sem sinal REAL medido, não se
				// gasta LLM. Sinal = chuva medida fresca, núcleo de radar perto, rio em
				// atenção ou aviso oficial. Previsão do ECMWF SOZINHA não é sinal —
				// foi ela que fez o boletim dizer que chovia sem chover.
				const estsGate = state.cemaden?.estacoes ?? [];
				const gAcc = (f: (e: (typeof estsGate)[number]) => number | null) =>
					maxAcumuladoFresco(estsGate, f) ?? 0;
				const sinalChuva =
					gAcc((e) => e.acc1hr) >= 0.5 ||
					gAcc((e) => e.acc6hr) >= 5 ||
					gAcc((e) => e.acc24hr) >= 10;
				const sinalRadar =
					state.alertLevel === "alert" || state.alertLevel === "watch";
				const sinalRio =
					state.hidro?.riscoCheia === "watch" ||
					state.hidro?.riscoCheia === "critical" ||
					state.hidro?.previsao?.vaiSair === "sim";
				const sinalOficial = (state.alertasOficiais?.avisos ?? []).length > 0;
				if (!(sinalChuva || sinalRadar || sinalRio || sinalOficial)) {
					const texto = [
						"Sem chuva medida em Ipiranga",
						"sem núcleo de chuva próximo no radar",
						"rios em nível normal",
					].join(", ");
					state.nowcastBulletin = {
						text: `${texto}. Nada a reportar agora.`,
						source: "heuristic",
						generatedAt: Date.now(),
					};
					logger.info(
						"Boletim sem sinal real — LLM NÃO chamado (gate de crédito)",
					);
				}
			}
			if (!state.nowcastBulletin) {
				// Boletim inteligente (10/09/2026): LLM analista (30 min) → heurística.
				// O LLM reconcilia fontes contraditórias (template não sabe fazer
				// isso); a heurística preenche intervalos e assume sem rede.
				// O contexto do analista foi montado ACIMA (o gate de reuso usa a
				// mesma impressão de cenário) — recalcular aqui só criaria divergência.
				const paramsBoletim = {
					nowcast,
					ecmwf: ecmwfCtx,
					relevance: {
						alertLevel: relevance.alertLevel,
						nearestThreatKm: relevance.nearestThreatKm,
					},
					local: localCtx,
					fraseLocal: built.fraseLocal,
					analyst: built.analyst,
					verdict: built.verdict,
				};
				if (!cachedBulletin) {
					// Sem NENHUM texto persistido (primeira execução, cache zerado):
					// aqui vale esperar — senão o site fica sem boletim nenhum.
					const bulletin = await generateSmartBulletin(paramsBoletim);
					state.nowcastBulletin = bulletin;
					logger.info("Boletim nowcast pronto (sem cache, aguardado)", {
						source: bulletin.source,
					});
				} else {
					// FORA DO CAMINHO CRÍTICO (22/09/2026): a cadeia de LLM pode gastar
					// os 15 s do orçamento e o ciclo chegava a 27-30 s — acima dos 30 s
					// que o cron-job.org capa (5 falhas em 50 execuções, cada uma virando
					// e-mail de falha e risco de auto-desabilitar o job). O texto é
					// persistido no Turso, então a geração pode terminar DEPOIS da
					// resposta: o ciclo devolve rápido servindo o cache anterior, e o
					// próximo ciclo já encontra o texto novo.
					state.nowcastBulletin = cachedBulletin;
					waitUntil(
						generateSmartBulletin(paramsBoletim)
							.then((b) => {
								logger.info("Boletim nowcast pronto em background", {
									source: b.source,
									idadeMin: Math.round((Date.now() - b.generatedAt) / 60000),
								});
							})
							.catch((err) => {
								logger.warn("Boletim nowcast falhou em background", {
									error: err instanceof Error ? err.message : String(err),
								});
							}),
					);
				}
				// NÃO regravar aqui: generateSmartBulletin já persistiu o texto novo —
				// e, quando reusa o cache, devolve o registro ANTIGO. Regravar um texto
				// reusado renovava o generated_at, então o cache de 30 min nunca
				// expirava e o boletim ficava congelado com horário "novo" a cada
				// ciclo. Foi o incidente do "Boletim IA" (22/09/2026).
			}

			// O boletim principal do dashboard/llms.txt é o texto do VLM vision.
			// O antigo "NIM texto" (Llama 8b) foi removido — um único boletim
			// coeso, gerado a partir dos dados do radar + veredito de ameaça.
			if (state.nowcastBulletin) {
				state.bulletin = {
					bulletin: state.nowcastBulletin.text,
					source: state.nowcastBulletin.source,
					generatedAt: state.nowcastBulletin.generatedAt,
				};
			}
			setCachedWeatherState(state);
		}
	} catch (err) {
		logger.warn("Nowcast falhou ao integrar ao estado", {
			error: String(err),
		});
	}

	// Alerta unificado próprio (10/09/2026): fusão determinística dos nossos
	// dados (CEMADEN+ECMWF+radar+hidro) com os avisos oficiais como agravante.
	// Roda no mesmo ciclo, nunca quebra o sync (try/catch interno).
	try {
		const oficiais = await promessaOficiais;
		state.alertasOficiais = oficiais;
		const estsA = state.cemaden?.estacoes ?? [];
		const maxA = (f: (e: (typeof estsA)[number]) => number | null) =>
			maxAcumuladoFresco(estsA, f);
		const prox6h = (weatherInfo.hourlyForecast || [])
			.slice(0, 6)
			.reduce((s, h) => s + (h.precipitationMm ?? 0), 0);
		const unificado = buildAlertaUnificado(
			{
				acc1hrMax: maxA((e) => e.acc1hr),
				acc6hrMax: maxA((e) => e.acc6hr),
				acc24hrMax: maxA((e) => e.acc24hr),
				pluviometroSemDado: !temEstacaoFresca(estsA),
				ecmwfPct: weatherInfo.rainProbabilityPct,
				ecmwfProx6hMm: prox6h,
				radarAlertLevel: state.alertLevel ?? "monitor",
				radarSevero: state.radarSevero ?? false,
				radarKind: state.radarKind ?? null,
				hidroWatch: state.hidro?.riscoCheia === "watch",
			},
			oficiais,
		);
		state.alertaUnificado = unificado;
		logAlertaUnificado(unificado);
		setCachedWeatherState(state);
		// Push no celular (PWA): só laranja/vermelho, com cooldown.
		// Nunca quebra o ciclo — falha de push é só log.
		try {
			const { pushParaAlerta, sendEventPush } = await import("./push.js");
			const regra = pushParaAlerta(unificado.nivel);
			if (regra) {
				const enviado = await sendEventPush(
					regra.evento,
					`${regra.emoji} ${unificado.titulo}`,
					unificado.descricao,
					regra.ttlMs,
				);
				logger.info("Push de alerta avaliado", {
					nivel: unificado.nivel,
					evento: regra.evento,
					enviado,
				});
			}
		} catch (err) {
			logger.warn("Push de alerta falhou (sem quebrar o ciclo)", {
				error: String(err),
			});
		}
	} catch (err) {
		logger.warn("Alerta unificado falhou (sem quebrar o ciclo)", {
			error: String(err),
		});
	}

	// Persistência compartilhada (achado 2026-08-15): grava o estado completo
	// no Turso para QUALQUER instância serverless servir sem regenerar a
	// cadeia VLM inline (a "eternidade" de 60s+ no /api/weather). Falha de
	// DB não derruba o ciclo.
	try {
		await saveWeatherStateCache(JSON.stringify(state));
	} catch (err) {
		logger.warn("Falha ao persistir weather_state_cache", {
			error: String(err),
		});
	}

	logger.info("Weather & radar sync cycle completed", {
		tempC: state.tempC,
		condition: state.condition,
		radarStatus: radar.status,
	});

	return state;
}

/** TTL do estado compartilhado no Turso: folga pro cron de 10 min do GH Actions. */
const TURSO_STATE_TTL_MS = 15 * 60_000;

/**
 * Estado do clima para servir requisições: memória (instância quente) →
 * cache compartilhado no Turso (gravado pelo cron a cada 10 min) → null
 * (o chamador cai no sync inline como último recurso). Remove o ciclo VLM
 * completo do request path — visitante nunca espera o VLM.
 */
async function loadWeatherState(
	maxAgeMs: number = TURSO_STATE_TTL_MS,
): Promise<WeatherState | null> {
	const mem = getCachedWeatherState();
	if (mem && Date.now() - mem.updatedAt <= 600_000) return mem;
	try {
		const cached = await getWeatherStateCache();
		if (cached && Date.now() - cached.updatedAt <= maxAgeMs) {
			const parsed = JSON.parse(cached.payload) as WeatherState;
			if (parsed && typeof parsed.updatedAt === "number") {
				setCachedWeatherState(parsed);
				return parsed;
			}
		}
	} catch (err) {
		logger.warn("Falha ao ler weather_state_cache", { error: String(err) });
	}
	return null;
}

/** Request aceito pelo handler: Web Request nativo ou objeto Node-style */
interface IncomingRequest {
	url?: string;
	method?: string;
	headers?: {
		get?: (name: string) => string | null;
		[name: string]: unknown;
	};
	body?: unknown;
	json?: () => Promise<unknown>;
}

function getHeader(req: IncomingRequest, name: string): string | null {
	if (!req) return null;
	if (req.headers && typeof req.headers.get === "function") {
		return req.headers.get(name);
	}
	if (req.headers) {
		const val = req.headers[name.toLowerCase()];
		if (Array.isArray(val)) return val[0] || null;
		if (typeof val === "string") return val;
	}
	return null;
}

function getClientIp(req: IncomingRequest): string {
	return (
		getHeader(req, "x-forwarded-for")?.split(",")[0]?.trim() ||
		getHeader(req, "x-real-ip") ||
		"unknown"
	);
}

async function getReqJson(req: IncomingRequest): Promise<unknown> {
	if (!req) return {};
	if (req.body && typeof req.body === "object") return req.body;
	if (typeof req.json === "function") {
		return await req.json().catch(() => ({}));
	}
	return {};
}

/**
 * Recorte do payload /api/weather (22/09/2026).
 *
 * Medido: 292 KB, dos quais 253 KB eram `nowcast.frames` — e o front usa SÓ o
 * último frame (frames[length-1]) para as setas de direção, mais a contagem e o
 * horário. Em celular (1,6 Mbps) isso é ~1,2 s de banda roubada do próprio
 * radar, que aparece na mesma tela. O estado INTERNO continua completo (é ele
 * que a análise, o boletim e o push consomem) — o recorte é só na saída HTTP.
 */
function enxugarPayloadParaCliente(state: WeatherState | null): unknown {
	if (!state || !state.nowcast) return state;
	const nc = state.nowcast;
	const frames = nc.frames ?? [];
	if (frames.length <= 1) return state;
	return {
		...state,
		nowcast: {
			...nc,
			frames: [frames[frames.length - 1]],
			framesTotal: frames.length,
		},
	};
}

export async function handleRequest(
	reqIn: IncomingRequest | string,
): Promise<Response> {
	await ensureInitialized();

	// Normaliza: string (URL) vira objeto; Request nativo já é IncomingRequest
	const req: IncomingRequest =
		typeof reqIn === "string" ? { url: reqIn, method: "GET" } : reqIn;

	let rawUrl = req.url || "/";
	if (!rawUrl.startsWith("http://") && !rawUrl.startsWith("https://")) {
		const host = getHeader(req, "host") || "servicos-status.vercel.app";
		rawUrl = `http://${host}${rawUrl.startsWith("/") ? "" : "/"}${rawUrl}`;
	}

	const url = new URL(rawUrl);
	const path = url.pathname;
	const method = (req.method || "GET").toUpperCase();

	if (method === "OPTIONS") {
		const origin = getHeader(req, "origin");
		const headers: Record<string, string> = {
			"Access-Control-Allow-Methods": "GET, POST, OPTIONS, HEAD",
			"Access-Control-Allow-Headers": "Content-Type, Authorization",
		};
		if (origin && ALLOWED_ORIGINS.has(origin)) {
			headers["Access-Control-Allow-Origin"] = origin;
			headers["Vary"] = "Origin";
		}
		return new Response(null, { status: 204, headers });
	}

	// Rotas de leitura: rejeitar métodos de escrita (405) em vez de responder
	// 200 para POST/PUT/DELETE/PATCH (achado pentest 2026-08-12).
	const READ_ONLY_PATHS = new Set([
		"/health",
		"/llms.txt",
		"/llms-full.txt",
		"/llms-instructions.txt",
		"/chuva-hoje",
		"/rio-bitumirim",
		"/como-ler-radar",
		"/sitemap.xml",
		"/api/services",
		"/api/report",
		"/api/weather",
		"/api/weather/radar",
		"/api/weather/nowcast",
		"/api/weather/json-ld",
		"/api/weather/bulletin",
		"/api/hidro",
		"/api/alertas",
		"/api/stats/daily",
		"/api/stats",
		"/api/push/status",
	]);
	if (READ_ONLY_PATHS.has(path) && method !== "GET" && method !== "HEAD") {
		return new Response(JSON.stringify({ error: "Método não permitido" }), {
			status: 405,
			headers: { "Content-Type": "application/json", Allow: "GET, HEAD" },
		});
	}

	// Serve llms.txt endpoints without rate limits
	if (path === "/llms.txt" || path === "/llms-full.txt") {
		// Staleness check (Achado 1): igual ao /api/weather — não servir estado
		// velho de instância quente. O sync reutiliza o boletim persistido no
		// Turso enquanto < 10 min, então não gasta cota NIM à toa. O estado
		// compartilhado no Turso (cron de 10 min) cobre instâncias frias sem
		// regenerar o ciclo VLM inline (achado 2026-08-15).
		let state = await loadWeatherState();
		if (!state) {
			state = await syncWeatherCycle();
		}
		const text = renderLlmsTxt(state, lastUnifiedReport);
		return new Response(text, {
			headers: {
				"Content-Type": "text/plain; charset=utf-8",
				// max-age reduzido + stale-while-revalidate: dado fresco com
				// latência de origem escondida da CDN.
				"Cache-Control": "public, max-age=120, stale-while-revalidate=60",
			},
		});
	}

	// Instruções para agentes separadas dos dados (Achado 7): /llms.txt só tem
	// dado + metadados; o imperativo fica aqui, fora do payload de dados.
	if (path === "/llms-instructions.txt") {
		return new Response(renderLlmsInstructions(), {
			headers: {
				"Content-Type": "text/plain; charset=utf-8",
				"Cache-Control": "public, max-age=3600",
			},
		});
	}

	// Rate limit all /api/* endpoints except /health
	if (path.startsWith("/api/")) {
		const ip = getClientIp(req);
		// /api/push/status é config PÚBLICA do botão de notificações (VAPID
		// pública + contagem): o frontend consulta no load de toda página.
		// Rate limit comum (10/min) fazia o botão SUMIR silenciosamente quando
		// o visitante recarregava muito (bug reportado 2026-08-12). Sem
		// rate limit, como /health — endpoint leve e sem dados sensíveis.
		if (path === "/api/push/status") {
			// sem rate limit — o botão precisa responder sempre
		} else if (path === "/api/track") {
			const { allowed, retryAfter } = checkRateLimitScope(ip, 120, "track");
			if (!allowed) {
				return new Response(
					JSON.stringify({ error: "Too many requests", retryAfter }),
					{
						status: 429,
						headers: {
							"Content-Type": "application/json",
							"Retry-After": String(retryAfter),
						},
					},
				);
			}
		} else if (path.startsWith("/api/admin/")) {
			const { allowed, retryAfter } = checkRateLimitScope(ip, 20, "admin");
			if (!allowed) {
				return new Response(
					JSON.stringify({ error: "Too many requests", retryAfter }),
					{
						status: 429,
						headers: {
							"Content-Type": "application/json",
							"Retry-After": String(retryAfter),
						},
					},
				);
			}
		} else {
			const { allowed, retryAfter } = checkRateLimit(ip);
			if (!allowed) {
				return new Response(
					JSON.stringify({
						error: "Too many requests",
						retryAfter,
						limit: "10 requests per minute",
					}),
					{
						status: 429,
						headers: {
							"Content-Type": "application/json",
							"Retry-After": String(retryAfter),
							"X-RateLimit-Limit": "10",
							"X-RateLimit-Remaining": "0",
							"X-RateLimit-Reset": String(
								Math.ceil((Date.now() + retryAfter * 1000) / 1000),
							),
						},
					},
				);
			}
		}
	}

	try {
		// Páginas de resposta direta (conteúdo indexável + LLM-friendly). HTML puro
		// servido do MESMO estado do dashboard: o texto não depende de JavaScript,
		// porque quem lê é buscador, agente de IA e leitor de tela — nenhum deles
		// executa script.
		if (
			path === "/chuva-hoje" ||
			path === "/rio-bitumirim" ||
			path === "/como-ler-radar"
		) {
			const { renderChuvaHoje, renderRioBitumirim, renderComoLerRadar } =
				await import("./paginas-conteudo.js");
			// Mesma regra do /api/weather: instância fria serve o último estado
			// persistido em vez de fazer o visitante esperar o ciclo completo.
			let state = await loadWeatherState();
			if (!state) state = await loadWeatherState(3 * 60 * 60_000);
			const html =
				path === "/chuva-hoje"
					? renderChuvaHoje(state)
					: path === "/rio-bitumirim"
						? renderRioBitumirim(state)
						: renderComoLerRadar(state);
			return new Response(html, {
				headers: {
					"Content-Type": "text/html; charset=utf-8",
					"Cache-Control":
						"public, max-age=60, s-maxage=300, stale-while-revalidate=900",
				},
			});
		}
		if (path === "/sitemap.xml") {
			const { renderSitemap } = await import("./paginas-conteudo.js");
			const state = await loadWeatherState();
			return new Response(renderSitemap(state), {
				headers: {
					"Content-Type": "application/xml; charset=utf-8",
					"Cache-Control": "public, max-age=600, s-maxage=1800",
				},
			});
		}
		if (path === "/health" || path === "/health/") return handleHealth();
		if (path === "/api/services" || path === "/api/report") {
			if (!lastUnifiedReport) await runChecks();
			return handleServices();
		}
		if (path === "/api/weather" || path === "/api/weather/radar") {
			// Instância quente serve state velho (cache em memória é por instância);
			// o estado compartilhado no Turso (cron de 10 min) cobre instâncias
			// frias SEM regenerar o ciclo VLM inline (achado 2026-08-15 — antes,
			// instância fria rodava o sync completo e o visitante esperava 60s+).
			let state = await loadWeatherState();
			if (!state) {
				// NUNCA faça o VISITANTE pagar o ciclo completo (12,5 s medidos em
				// instância fria — era o "radar demora pra aparecer"): serve o último
				// estado persistido, mesmo velho, e deixa o cron de 10 min atualizar.
				// O payload carrega updatedAt, então a UI continua honesta sobre a
				// idade do dado; sync inline só se o Turso não tiver NADA.
				state = await loadWeatherState(3 * 60 * 60_000);
				if (state) {
					logger.warn("Servindo estado PERSISTIDO mais velho que o TTL", {
						idadeMin: Math.round((Date.now() - state.updatedAt) / 60_000),
					});
				}
			}
			if (!state) state = await syncWeatherCycle();
			return Response.json(
				enxugarPayloadParaCliente(state) ?? {
					error: "Sem dados climatológicos no momento",
				},
				{
					headers: {
						// s-maxage: cache de BORDA (a resposta da função não era cacheada —
						// x-vercel-cache: MISS em toda visita, cold start na cara do visitante).
						// stale-while-revalidate: serve o cache enquanto revalida em background.
						"Cache-Control":
							"public, max-age=30, s-maxage=60, stale-while-revalidate=600",
						"Vercel-CDN-Cache-Control":
							"public, s-maxage=60, stale-while-revalidate=600",
					},
				},
			);
		}
		if (path === "/api/weather/nowcast") {
			const nowcast = await getRadarNowcast();
			return Response.json(nowcast, {
				headers: { "Cache-Control": "public, max-age=240" },
			});
		}
		if (path === "/api/weather/json-ld") {
			const jsonLd = renderJsonLd(getCachedWeatherState(), lastUnifiedReport);
			return new Response(JSON.stringify(jsonLd, null, 2), {
				headers: {
					"Content-Type": "application/ld+json; charset=utf-8",
					"Cache-Control": "public, max-age=300",
				},
			});
		}
		if (path === "/api/weather/bulletin") {
			const state = getCachedWeatherState();
			// Instância fria não tem state em memória: fallback para o último
			// boletim persistido no Turso (Camada B) — nunca retorna vazio
			// sem necessidade.
			const cached = state?.nowcastBulletin ?? state?.bulletin ?? null;
			if (cached) {
				const text = "text" in cached ? cached.text : (cached.bulletin ?? null);
				return Response.json({
					bulletin: text,
					source: cached.source ?? null,
					timestamp: Date.now(),
				});
			}
			const persisted = await getLatestNowcastBulletin();
			return Response.json({
				bulletin: persisted?.text ?? null,
				source: persisted?.source ?? null,
				generatedAt: persisted?.generatedAt ?? null,
				timestamp: Date.now(),
			});
		}

		if (path === "/api/hidro") {
			let state = getCachedWeatherState();
			if (!state) state = await loadWeatherState();
			const hidro = state?.hidro ?? null;
			if (!hidro) {
				return Response.json(
					{
						error:
							"Dados hidro ainda não disponíveis — aguarde o próximo ciclo",
					},
					{ status: 503, headers: { "Cache-Control": "public, max-age=30" } },
				);
			}
			return Response.json(hidro, {
				headers: {
					"Cache-Control": "public, max-age=120, stale-while-revalidate=60",
				},
			});
		}

		if (path === "/api/alertas") {
			let state = getCachedWeatherState();
			if (!state) state = await loadWeatherState();
			const payload = {
				unificado: state?.alertaUnificado ?? null,
				oficiais: state?.alertasOficiais ?? null,
			};
			if (!payload.unificado) {
				return Response.json(
					{ error: "Alerta ainda não calculado — aguarde o próximo ciclo" },
					{ status: 503, headers: { "Cache-Control": "public, max-age=30" } },
				);
			}
			return Response.json(payload, {
				headers: {
					"Cache-Control": "public, max-age=120, stale-while-revalidate=60",
				},
			});
		}

		if (path === "/api/check" && method === "POST") {
			// Dispara ciclo completo (probes externos + NIM + Telegram): só
			// com Bearer CRON_SECRET — nunca público (achado pentest:
			// qualquer um gastava cota e spammava alertas).
			const cronSecret = loadConfig().cronSecret;
			const auth = getHeader(req, "authorization") ?? "";
			if (!cronSecret || auth !== `Bearer ${cronSecret}`) {
				return new Response(JSON.stringify({ error: "Não autorizado" }), {
					status: 401,
					headers: { "Content-Type": "application/json" },
				});
			}
			await runChecks();
			return Response.json({ status: "ok", timestamp: Date.now() });
		}
		// ===== Telemetria de uso (acessos, instalações, sessões) =====
		if (path === "/api/track" && method === "POST") {
			try {
				const { trackEvent } = await import("./admin.js");
				const body = (await getReqJson(req)) as {
					event?: string;
					sessionId?: string;
				};
				const tipo = String(body?.event ?? "");
				if (!["pageview", "install", "heartbeat"].includes(tipo)) {
					return new Response(JSON.stringify({ error: "evento inválido" }), {
						status: 400,
						headers: { "Content-Type": "application/json" },
					});
				}
				await trackEvent(tipo, body?.sessionId ? String(body.sessionId) : null);
				return Response.json({ status: "ok", timestamp: Date.now() });
			} catch (err: unknown) {
				const errMsg = err instanceof Error ? err.message : String(err);
				logger.error("Handler error", { path, error: errMsg });
				return new Response(JSON.stringify({ error: "Requisição inválida" }), {
					status: 400,
					headers: { "Content-Type": "application/json" },
				});
			}
		}
		// ===== Painel Admin (só o dono) =====
		if (path === "/api/admin/login" && method === "POST") {
			// Rate limit dedicado de login (5/min por IP), além do escopo
			// "admin" (20/min): corta rajadas de brute force. O atraso fixo
			// de 1.2s abaixo desacelera tentativas distribuídas.
			const { allowed, retryAfter } = checkRateLimitScope(
				getClientIp(req),
				5,
				"login",
			);
			if (!allowed) {
				return new Response(
					JSON.stringify({ error: "Too many requests", retryAfter }),
					{
						status: 429,
						headers: {
							"Content-Type": "application/json",
							"Retry-After": String(retryAfter),
						},
					},
				);
			}
			const {
				adminConfigured,
				adminEmail,
				createSessionToken,
				sessionCookie,
				verifyPassword,
			} = await import("./admin.js");
			if (!adminConfigured()) {
				return new Response(
					JSON.stringify({ error: "Admin não configurado" }),
					{ status: 503, headers: { "Content-Type": "application/json" } },
				);
			}
			const body = (await getReqJson(req)) as {
				email?: string;
				password?: string;
			};
			const ok =
				String(body?.email ?? "").toLowerCase() ===
					adminEmail().toLowerCase() &&
				verifyPassword(
					String(body?.password ?? ""),
					loadConfig().adminPasswordHash,
				);
			// Atraso fixo anti brute-force (serverless não tem memória de
			// tentativas entre instâncias — o atraso uniformiza a força).
			await new Promise((r) => setTimeout(r, 1200));
			if (!ok) {
				return new Response(
					JSON.stringify({ error: "Credenciais inválidas" }),
					{ status: 401, headers: { "Content-Type": "application/json" } },
				);
			}
			const token = createSessionToken();
			return new Response(JSON.stringify({ status: "ok" }), {
				status: 200,
				headers: {
					"Content-Type": "application/json",
					"Set-Cookie": sessionCookie(token),
				},
			});
		}
		if (path === "/api/admin/logout" && method === "POST") {
			const { clearSessionCookie } = await import("./admin.js");
			return new Response(JSON.stringify({ status: "ok" }), {
				status: 200,
				headers: {
					"Content-Type": "application/json",
					"Set-Cookie": clearSessionCookie(),
				},
			});
		}
		if (path === "/api/admin/me" && method === "GET") {
			const {
				adminConfigured,
				adminEmail,
				getSessionTokenFromCookie,
				verifySessionToken,
			} = await import("./admin.js");
			const token = getSessionTokenFromCookie(getHeader(req, "cookie"));
			const authed = verifySessionToken(token);
			return Response.json({
				authed,
				// Não expor "admin existe" para quem não está autenticado
				// (achado pentest: recon via /api/admin/me sem auth).
				configured: authed ? adminConfigured() : false,
				email: authed ? adminEmail() : null,
				timestamp: Date.now(),
			});
		}
		if (path === "/api/admin/stats" && method === "GET") {
			const { getAdminStats, getSessionTokenFromCookie, verifySessionToken } =
				await import("./admin.js");
			const token = getSessionTokenFromCookie(getHeader(req, "cookie"));
			if (!verifySessionToken(token)) {
				return new Response(JSON.stringify({ error: "Não autenticado" }), {
					status: 401,
					headers: { "Content-Type": "application/json" },
				});
			}
			return Response.json(await getAdminStats());
		}
		// Lista de inscritos nos alertas (para o dono ver QUEM está inscrito —
		// host do push service + datas; ajuda a separar visitantes reais das
		// inscrições sintéticas de teste). Autenticado como o resto do admin.
		if (path === "/api/admin/push-subscriptions" && method === "GET") {
			const { getSessionTokenFromCookie, verifySessionToken } = await import(
				"./admin.js"
			);
			const token = getSessionTokenFromCookie(getHeader(req, "cookie"));
			if (!verifySessionToken(token)) {
				return new Response(JSON.stringify({ error: "Não autenticado" }), {
					status: 401,
					headers: { "Content-Type": "application/json" },
				});
			}
			const { listPushSubscriptionsMeta } = await import("./push.js");
			return Response.json({
				subscriptions: await listPushSubscriptionsMeta(),
			});
		}
		// ===== WebAuthn (impressão digital / passkey) =====
		const authOk = await (async () => {
			const { getSessionTokenFromCookie, verifySessionToken } = await import(
				"./admin.js"
			);
			return verifySessionToken(
				getSessionTokenFromCookie(getHeader(req, "cookie")),
			);
		})();
		if (path === "/api/admin/webauthn/register/begin" && method === "POST") {
			if (!authOk) {
				return new Response(JSON.stringify({ error: "Não autenticado" }), {
					status: 401,
					headers: { "Content-Type": "application/json" },
				});
			}
			const { webauthnRegisterBegin } = await import("./admin.js");
			const out = await webauthnRegisterBegin(getHeader(req, "host"));
			if (!out) {
				return new Response(
					JSON.stringify({ error: "WebAuthn indisponível" }),
					{ status: 500, headers: { "Content-Type": "application/json" } },
				);
			}
			return Response.json(out);
		}
		if (path === "/api/admin/webauthn/register/complete" && method === "POST") {
			if (!authOk) {
				return new Response(JSON.stringify({ error: "Não autenticado" }), {
					status: 401,
					headers: { "Content-Type": "application/json" },
				});
			}
			const { webauthnRegisterComplete } = await import("./admin.js");
			const out = await webauthnRegisterComplete(
				await getReqJson(req),
				getHeader(req, "origin"),
			);
			return Response.json(out, { status: out.ok ? 200 : 400 });
		}
		if (path === "/api/admin/webauthn/login/begin" && method === "POST") {
			const { webauthnLoginBegin } = await import("./admin.js");
			const out = await webauthnLoginBegin(getHeader(req, "host"));
			if (!out) {
				return new Response(
					JSON.stringify({ error: "Nenhuma passkey registrada" }),
					{ status: 404, headers: { "Content-Type": "application/json" } },
				);
			}
			return Response.json(out);
		}
		if (path === "/api/admin/webauthn/login/complete" && method === "POST") {
			const { sessionCookie, webauthnLoginComplete } = await import(
				"./admin.js"
			);
			const out = await webauthnLoginComplete(
				await getReqJson(req),
				getHeader(req, "origin"),
			);
			if (!out.ok || !out.token) {
				return new Response(JSON.stringify({ error: out.error ?? "Falha" }), {
					status: 400,
					headers: { "Content-Type": "application/json" },
				});
			}
			return new Response(JSON.stringify({ status: "ok" }), {
				status: 200,
				headers: {
					"Content-Type": "application/json",
					"Set-Cookie": sessionCookie(out.token),
				},
			});
		}
		// ===== Push Web (PWA) — inscrições e teste =====
		if (path === "/api/push/status") {
			const { countPushSubscriptions, pushConfigured } = await import(
				"./push.js"
			);
			const config = loadConfig();
			return Response.json({
				configured: pushConfigured(),
				vapidPublicKey: config.vapidPublicKey || null,
				subscribers: await countPushSubscriptions().catch(() => 0),
				timestamp: Date.now(),
			});
		}
		if (path === "/api/push/subscribe" && method === "POST") {
			try {
				const { savePushSubscription } = await import("./push.js");
				const body = (await getReqJson(req)) as {
					endpoint?: string;
					keys?: { p256dh?: string; auth?: string };
				};
				if (!body?.endpoint || !body?.keys?.p256dh || !body?.keys?.auth) {
					return new Response(
						JSON.stringify({ error: "Inscrição incompleta (endpoint/keys)" }),
						{ status: 400, headers: { "Content-Type": "application/json" } },
					);
				}
				await savePushSubscription({
					endpoint: body.endpoint,
					keys: { p256dh: body.keys.p256dh, auth: body.keys.auth },
				});
				return Response.json({ status: "ok", timestamp: Date.now() });
			} catch (err: unknown) {
				const errMsg = err instanceof Error ? err.message : String(err);
				logger.error("Handler error", { path, error: errMsg });
				return new Response(JSON.stringify({ error: "Requisição inválida" }), {
					status: 400,
					headers: { "Content-Type": "application/json" },
				});
			}
		}
		if (path === "/api/push/unsubscribe" && method === "POST") {
			try {
				const { removePushSubscription } = await import("./push.js");
				const body = (await getReqJson(req)) as { endpoint?: string };
				if (!body?.endpoint) {
					return new Response(JSON.stringify({ error: "endpoint ausente" }), {
						status: 400,
						headers: { "Content-Type": "application/json" },
					});
				}
				await removePushSubscription(body.endpoint);
				return Response.json({ status: "ok", timestamp: Date.now() });
			} catch (err: unknown) {
				const errMsg = err instanceof Error ? err.message : String(err);
				logger.error("Handler error", { path, error: errMsg });
				return new Response(JSON.stringify({ error: "Requisição inválida" }), {
					status: 400,
					headers: { "Content-Type": "application/json" },
				});
			}
		}
		if (path === "/api/push/test" && method === "POST") {
			// Push para TODOS os inscritos do PWA: exige sessão admin
			// (achado pentest: endpoint público spammava todos os usuários).
			const { getSessionTokenFromCookie, verifySessionToken } = await import(
				"./admin.js"
			);
			if (
				!verifySessionToken(getSessionTokenFromCookie(getHeader(req, "cookie")))
			) {
				return new Response(JSON.stringify({ error: "Não autenticado" }), {
					status: 401,
					headers: { "Content-Type": "application/json" },
				});
			}
			// Envia um push de teste pra todos os inscritos (validar o fluxo).
			const { sendPushAlert } = await import("./push.js");
			const r = await sendPushAlert(
				"🔔 Monitor Ipiranga",
				"Teste de alerta — notificações funcionando!",
				"/",
			);
			return Response.json({ ...r, timestamp: Date.now() });
		}
		// /api/signal-report (relato de sinal do morador por operadora) foi
		// removido em 22/09/2026: só alimentava o status das operadoras, que
		// saiu do produto. Não confundir com /api/track (telemetria de uso do
		// site — acessos/sessões/instalações), que continua.
		if (path === "/api/stats/daily" || path === "/api/stats") {
			return Response.json({
				daily: await getDailyStatsSummary(),
				timestamp: Date.now(),
			});
		}
		// /api/telemetry (HEAD/GET de ping + POST com rtt/tipo de conexão) e o
		// /api/telemetry/stats eram o teste de provedor/ISP do visitante —
		// removidos em 22/09/2026 junto com as operadoras. O /api/track
		// (acessos/instalações/sessões) é outra coisa e continua.
		// Static file fallback for local Bun runtime
		if (typeof Bun !== "undefined" && typeof Bun.file === "function") {
			const staticPath = `${import.meta.dir}/public${path === "/" ? "/index.html" : path}`;
			const staticFile = Bun.file(staticPath);
			if (await staticFile.exists()) {
				return new Response(staticFile);
			}
		}

		return new Response("Not found", { status: 404 });
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		logger.error("API error", {
			path,
			error: msg,
			stack: err instanceof Error ? err.stack : undefined,
		});
		// Nunca vazar mensagens internas (stack/paths de arquivos) pro cliente
		// (achado pentest: catch devolvia {error: msg} em 500).
		return new Response(JSON.stringify({ error: "Erro interno" }), {
			status: 500,
			headers: { "Content-Type": "application/json" },
		});
	}
}

const startTime = Date.now();
let checkInterval: ReturnType<typeof setInterval> | null = null;
let server: { stop: () => void } | null = null;

async function runOnce(): Promise<void> {
	await ensureInitialized();
	logger.info("Running single check cycle (--once)");

	const data = await runAllChecks(config, tracker);

	for (const outage of data.newCopelOutages) {
		await sendCopelAlert(
			outage,
			config.telegramBotToken,
			config.telegramChatId,
		);
	}

	for (const intr of data.newSaneparInterruptions) {
		await sendSaneparAlert(
			intr,
			config.telegramBotToken,
			config.telegramChatId,
		);
	}

	logger.info("Single check cycle completed", {
		newCopel: data.newCopelOutages.length,
		newSanepar: data.newSaneparInterruptions.length,
	});
}

async function main(): Promise<void> {
	if (process.argv.includes("--once")) {
		await runOnce();
		closeDb();
		process.exit(0);
	}

	logger.info("Starting services-health monitor", {
		municipio: config.municipio || "(não configurado)",
		checkIntervalMs: config.checkIntervalMs,
		httpPort: config.httpPort,
	});

	// Start HTTP server immediately so Healthcheck probes (Docker, Fly.io, Render) pass right away
	server = Bun.serve({
		port: config.httpPort,
		fetch: (req: Request) => handleRequest(req as unknown as IncomingRequest),
	});

	logger.info(`HTTP server listening on :${config.httpPort}`);

	process.on("SIGTERM", gracefulShutdown);
	process.on("SIGINT", gracefulShutdown);

	// Run initial checks asynchronously without blocking port binding
	Promise.all([runChecks(), syncWeatherCycle()]).catch((err) => {
		logger.error("Error during initial check cycle", { error: String(err) });
	});

	checkInterval = setInterval(runChecks, config.checkIntervalMs);
	// Ciclo de clima/radar/boletim a cada 10 min (era 15) — pedido do Dave
	// 2026-08-12: "diminua o tempo de verificação para 10 minutos".
	weatherInterval = setInterval(syncWeatherCycle, 600_000);
}

async function gracefulShutdown(): Promise<void> {
	logger.info("Shutting down gracefully...");

	if (checkInterval) clearInterval(checkInterval);
	if (weatherInterval) clearInterval(weatherInterval);
	if (server) server.stop();
	closeDb();

	logger.info("Shutdown complete");
	process.exit(0);
}

if (typeof Bun !== "undefined" && import.meta.path === Bun.main) {
	main().catch((err: unknown) => {
		const msg = err instanceof Error ? err.message : String(err);
		logger.error("Fatal error during startup", { error: msg });
		process.exit(1);
	});
}
