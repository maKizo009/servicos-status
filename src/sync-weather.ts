/**
 * Ciclo de sincronização do Monitor Ipiranga — extraído de index.ts (01/10/2026).
 *
 * `syncWeatherCycle` é o coração do monitor (~700 linhas): coleta radar/CEMADEN/
 * ANA/Sigma/COPEL/Sanepar, monta o nowcast, gera o boletim (LLM com fallback
 * heurístico), decide o nível de alerta unificado e dispara push. Vivia dentro
 * de index.ts junto do router — cada fix que tocava o ciclo relia 2 mil linhas.
 * Extraído sem mudar comportamento: só organização.
 */
import {
	buildAlertaUnificado,
	descricaoParaPessoas,
	fetchAlertasOficiais,
	logAlertaUnificado,
} from "./alertas-oficiais.js";
import { fetchHidroTriangulacao, preservarHidro } from "./ana-hidro.js";
import {
	fetchCemadenIpiranga,
	maxAcumuladoFresco,
	temEstacaoFresca,
} from "./cemaden.js";
import {
	getLatestNowcastBulletin,
	getLatestWeatherBulletin,
	lerCiclosAlerta,
	lerUltimoNivelAlerta,
	limparAmostrasDissipacaoAntigas,
	limparCiclosAlertaAntigos,
	salvarCicloAlerta,
	saveNowcastBulletin,
	saveWeatherStateCache,
} from "./db.js";
import { logger } from "./logger.js";
import { getRadarNowcast } from "./nowcast-service.js";
import type { AmostraNucleo } from "./dissipacao.js";
import {
	avaliarPersistencia,
	type VereditoPersistencia,
} from "./persistencia-alerta.js";
import {
	avaliarNucleoSevero,
	fmtEta,
	formatRainEntityAlert,
	nearestStrongThreat,
	pickAmeaca,
	RELEVANCE_ZONES,
	type VereditoNucleoSevero,
} from "./radar-analysis.js";
import {
	CIDADES_CORREDOR,
	cidadesComNucleo,
	fetchSigmaRede,
	resumoSolo,
	SIGMA_RAIO_CIDADE_KM,
	type SigmaResultado,
} from "./sigma-feed.js";
import {
	fetchCurrentWeather,
	fetchRainViewerRadar,
	getCachedWeatherState,
	setCachedWeatherState,
} from "./weather-collector.js";
import { loadConfig } from "./config.js";
import {
	ensureInitialized,
	loadWeatherState,
} from "./runtime-state.js";
import type { RainAlertLevel, WeatherState } from "./types.js";

export async function syncWeatherCycle(): Promise<WeatherState> {
	const config = loadConfig();
	await ensureInitialized();
	// Nível do alerta no ciclo ANTERIOR, lido ANTES de qualquer cache deste ciclo:
	// é o que permite narrar rebaixamento/subida do tom (maleabilidade pedida pelo
	// dono 27/09/2026). Sem ciclo anterior (cold start) fica null — sem frase.
	// O cache em memória morre no cold start da Vercel; por isso o fallback lê o
	// nível do último ciclo GRAVADO no banco (persistência, 29/09/2026).
	let nivelAlertaAnterior =
		getCachedWeatherState()?.alertaUnificado?.nivel ?? null;
	if (!nivelAlertaAnterior) {
		try {
			const persistido = await lerUltimoNivelAlerta();
			nivelAlertaAnterior =
				persistido === "verde" ||
				persistido === "amarelo" ||
				persistido === "laranja" ||
				persistido === "vermelho"
					? persistido
					: null;
		} catch (err) {
			logger.warn("Nível anterior não pôde ser lido do banco", {
				error: String(err),
			});
		}
	}
	// Tendência do núcleo que dirige o alerta (escopo do ciclo: lida no bloco do
	// radar, usada na narração da transição e no push).
	let nucleoTendencia: "intensificando" | "estavel" | "enfraquecendo" | null =
		null;
	// Evidência severa do ciclo (preenchida no bloco do radar) e o veredito de
	// persistência — a laranja/push agora exige que a evidência se SUSTENTE entre
	// ciclos, não que apareça uma vez. Id do ciclo = ts do frame de radar.
	let vereditoSevero: VereditoNucleoSevero | null = null;
	let persistenciaCiclo: VereditoPersistencia | null = null;
	let cicloTs = 0;
	// Livro da dissipação: amostras do ciclo (preenchidas no bloco do radar,
	// gravadas no banco depois que o nível do alerta do ciclo existe).
	const amostrasLivro: AmostraNucleo[] = [];
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
	const hidro = preservarHidro(
		await fetchHidroTriangulacao({
			p1h: maxAcc((e) => e.acc1hr),
			p6h: maxAcc((e) => e.acc6hr),
			p24h: maxAcc((e) => e.acc24hr),
			p72h: maxAcc((e) => e.acc72hr),
		}),
		// ANA fora do ar não apaga o card do rio: preserva a última triangulação
		// boa (marcada como desatualizada). TTL largo de propósito — o que importa
		// é a última leitura, não o ciclo anterior.
		(await loadWeatherState(24 * 3600_000))?.hidro,
	);

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
		// Saúde da fonte Open-Meteo: o fallback de defaults é dado INVENTADO e
		// precisa aparecer como falha no source-health (ver src/source-health.ts).
		fonteOpenMeteo: { ok: weatherInfo.ok, erro: weatherInfo.erro },
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


			// A distância anunciada é a do núcleo FORTE MAIS PRÓXIMO — não a do
			// primeiro da lista, que vem ordenada por PERIGO (aproximando com
			// menor ETA). Com `threats[0]` o card dizia "núcleo de chuva forte a
			// ~222 km" com um extreme a 74 km (incidente 27/09/2026). O verbo do
			// card ("vindo para a região") segue o veredito de movimento MEDIDO.
			const ameaca = pickAmeaca(nowcast.threats);
			state.ameaca = ameaca;
			state.nearestThreatKm = ameaca ? Math.round(ameaca.distToTargetKm) : null;
			state.nearestThreatApproach = ameaca?.threat?.approach ?? null;
			const alertLevel: RainAlertLevel = ameaca?.relevanceZone ?? "none";
			state.alertLevel = alertLevel;
			state.hasRegionalRain = alertLevel === "alert";
			// SEVERIDADE (push) ≠ RELEVÂNCIA (site). Área de chuva moderada é
			// relevante para o card e irrelevante para interromper o celular
			// (regra do dono 21/09/2026: "alertas só em casos realmente
			// importantes"). Só núcleo de tempestade na zona de alerta promove.
			// A zona pode ter MAIS DE UMA entidade e a lista vem por ETA: pegar a
			// primeira devolvia a ÁREA que chega antes e o alerta saía amarelo com
			// núcleo extreme iminente (incidente 27/09/2026).
			// Piso de severidade + tendência (29/09/2026): núcleo na METADE FRACA da
			// faixa "forte" (38–42 dBZ), isolado e enfraquecendo, não é evidência
			// para interromper o celular. Antes, só zona+tipo promoviam.
			const veredito = avaliarNucleoSevero(nowcast.threats, 512);
			vereditoSevero = veredito;
			const nucleoSevero =
				veredito?.severo === true ? veredito.cell : null;
			const nucleoProximo = nowcast.threats[0] ?? null;
			const nearestAlert = nowcast.threats.find(t => t.relevanceZone === "alert") ?? null;
			const nearestWatch = nowcast.threats.find(t => t.relevanceZone === "watch") ?? null;
			// Id do ciclo = timestamp do FRAME de radar analisado (não o relógio):
			// o cron pode rodar várias vezes no mesmo frame e a contagem de ciclos
			// consecutivos tem que refletir o radar, não a frequência do cron.
			const frameMaisNovo = nowcast.frames[nowcast.frames.length - 1];
			cicloTs =
				frameMaisNovo?.time ?? Math.floor(Date.now() / 600_000) * 600_000;
			nucleoTendencia =
				(nucleoSevero ?? nucleoProximo)?.tendencia ??
				(nucleoSevero ?? nucleoProximo)?.movement?.tendencia ??
				null;
			state.radarSevero = Boolean(nucleoSevero);
			// O kind do card é o da entidade que DIRIGE o alerta: núcleo severo >
			// a que chega primeiro (nearestAlert) > vigilância.
			state.radarKind =
				(nucleoSevero ?? nearestAlert ?? nearestWatch)?.kind ?? null;
			// Núcleo FORTE perto mas com veredito `crossing` cai em `monitor`: não é
			// risco iminente, mas também não é "sem chuva forte por perto". O leitor
			// precisa saber que existe célula de tempestade na região e o que ela
			// pode trazer (reclamação do dono 29/09/2026: "é bem estranho não ter um
			// alerta de chuva moderada/forte com raios e trovoadas e risco de
			// oscilações na rede elétrica"). O texto INFORMA; o nível não sobe por
			// isso (segue amarelo/verde) e o celular não é interrompido.
			const fortePerto =
				ameaca !== null &&
					(ameaca.intensity === "heavy" ||
					 ameaca.intensity === "extreme") &&
					ameaca.distToTargetKm <= RELEVANCE_ZONES.nearStrongKm &&
					ameaca.threat?.approach !== "receding";
			if (alertLevel === "monitor") {
				state.regionalRainAlert = fortePerto && ameaca
					? `⛈️ Núcleo de chuva forte a ~${Math.round(ameaca.distToTargetKm)} km de Ipiranga, medido ${
							ameaca.threat?.approach === "crossing"
								? "passando ao lado"
								: "em deslocamento"
						}. Célula de tempestade: pode trazer raios, rajadas e oscilações na rede elétrica (COPEL). Sem rumo direto para a cidade.`
					: `ℹ️ Monitoramento: atividade de radar detectada a ${ameaca ? `~${Math.round(ameaca.distToTargetKm)} km` : "grande distância"} de Ipiranga. Sem risco iminente no momento.`;
			} else {
				// Área de chuva (moderada) x núcleo (tempestade): o texto muda, o gate
				// não. Texto montado em formatRainEntityAlert (testável). O núcleo
				// severo manda no texto: dizer "área sem núcleo de tempestade" com um
				// núcleo extreme chegando é mentira (incidente 27/09/2026).
				// Determine the entity to display in the COPEL card
				const displayEntity =
					alertLevel === "alert"
						? (nucleoSevero ?? nearestAlert)
						: ((alertLevel as string) === "watch" || (alertLevel as string) === "monitor" || (alertLevel as string) === "none")
							? nearestWatch
							: null;

				if (displayEntity) {
					state.regionalRainAlert = formatRainEntityAlert({
						level: alertLevel === "alert" || alertLevel === "watch" ? alertLevel : "watch",
						kind: displayEntity.kind,
						intensity: displayEntity.intensity,
						distKm: displayEntity.distToTargetKm,
						approach: displayEntity.threat?.approach ?? null,
						etaMin: displayEntity.threat?.etaMin ?? null,
						tendencia: displayEntity.tendencia ?? displayEntity.movement?.tendencia ?? null,
						isolado: displayEntity.isolado === true,
						framesVivo: displayEntity.framesVivo ?? null,
					});
				} else {
					state.regionalRainAlert = `ℹ️ Monitoramento: sem chuva relevante no radar a caminho de Ipiranga.`;
				}
			}
			// Livro da dissipação: só entidades RELEVANTES (alert/watch) — monitor
			// não interessa para medir chuva que chega. O nível unificado do ciclo é
			// anexado depois (quando ele existe).
			for (const t of nowcast.threats) {
				if (t.relevanceZone === "monitor") continue;
				amostrasLivro.push({
					medidoEm: Date.now(),
					lat: t.lat,
					lon: t.lon,
					distKm: t.distToTargetKm,
					maxDbz: t.maxDbz,
					intensity: t.intensity,
					kind: t.kind,
					isolado: t.isolado ?? null,
					framesVivo: t.framesVivo ?? null,
					deltaDbz: t.movement?.deltaDbz ?? null,
					tendencia: t.movement?.tendencia ?? t.tendencia ?? null,
					approach: t.threat?.approach ?? null,
					etaMin: t.threat?.etaMin ?? null,
					zona: t.relevanceZone,
					nivel: null,
					chuva1hMm: maxAcc((e) => e.acc1hr),
					chuva6hMm: maxAcc((e) => e.acc6hr),
				});
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

		// Camada B: boletim narrativo DETERMINÍSTICO (04/10/2026).
		// A cadeia LLM saiu do ciclo a pedido do dono ("ninguém está lendo as
		// análises de IA") e pela cota de CPU da Vercel. O texto é a heurística
		// da Camada A (buildHeuristicBulletin): reconcilia radar + pluviômetro +
		// ECMWF + rios sem rede, sem provedor, sem cota. Persistido no Turso
		// como antes — /api/weather/bulletin, dashboard e watchdog leem daqui.
		if (state.radar) {
			const { buildHeuristicBulletin } = await import("./nowcast-vlm.js");
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
			const text = buildHeuristicBulletin(nowcast, ecmwfCtx, relevance, localCtx);
			state.nowcastBulletin = { text, source: "heuristic", generatedAt: Date.now() };
			// Grava só quando o texto MUDA (04/10/2026): o heurístico é regenerado
			// a cada ciclo; persistir igual-igual incharia a tabela. O
			// generatedAt do ESTADO é sempre agora — com boletim determinístico,
			// "texto igual" significa que a LEITURA atual do radar/chuva continua
			// a mesma, não texto velho servido de cache (era isso que o
			// generatedAt antigo denunciava, no mundo LLM de 22/09).
			try {
				const ultimo = await getLatestNowcastBulletin();
				if (!ultimo || ultimo.text !== text) {
					await saveNowcastBulletin(text, "heuristic", null);
				}
			} catch (e) {
				logger.warn("Boletim heurístico: persistência falhou", { error: String(e) });
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
		// PERSISTÊNCIA (29/09/2026): a evidência severa do ciclo precisa se
		// SUSTENTAR em ≥2 ciclos seguidos de radar para virar laranja/push.
		// Ler o histórico nunca quebra o ciclo; se a leitura falhar, o veredito
		// abre (fail-open) com motivo explícito — banco fora não pode virar
		// "nunca mais alerta".
		const severoAgora = vereditoSevero?.severo === true;
		const imediatoAgora = vereditoSevero?.imediato === true;
		try {
			const historico = await lerCiclosAlerta(Date.now() - 6 * 3600_000);
			persistenciaCiclo = avaliarPersistencia({
				historico,
				agoraMs: cicloTs,
				nucleoSeveroAgora: severoAgora,
				imediatoAgora,
			});
		} catch (err) {
			logger.warn("Persistência do alerta indisponível (fail-open)", {
				error: String(err),
			});
			persistenciaCiclo = avaliarPersistencia({
				historico: null,
				agoraMs: cicloTs,
				nucleoSeveroAgora: severoAgora,
				imediatoAgora,
			});
		}
		const severoConfirmado = persistenciaCiclo.persistiu;
		state.radarSeveroConfirmado = severoConfirmado;
		state.radarSeveroCiclos = persistenciaCiclo.ciclosConsecutivos;
		logger.info("Persistência do núcleo severo", {
			cicloTs,
			severoAgora,
			imediatoAgora,
			persistiu: severoConfirmado,
			ciclos: persistenciaCiclo.ciclosConsecutivos,
			motivo: persistenciaCiclo.motivo,
			descricao: persistenciaCiclo.descricao,
		});
		// Card honesto: núcleo severo de 1º ciclo é VIGILÂNCIA, não alerta —
		// dizer o motivo evita o leitor achar que o monitor "perdeu" o núcleo.
		if (severoAgora && !severoConfirmado && state.regionalRainAlert) {
			state.regionalRainAlert +=
				" Núcleo severo no 1º ciclo do radar — o monitor aguarda o próximo ciclo antes de interromper o celular.";
		}
		const unificado = buildAlertaUnificado(
			{
				acc1hrMax: maxA((e) => e.acc1hr),
				acc6hrMax: maxA((e) => e.acc6hr),
				acc24hrMax: maxA((e) => e.acc24hr),
				pluviometroSemDado: !temEstacaoFresca(estsA),
				ecmwfPct: weatherInfo.rainProbabilityPct,
				ecmwfProx6hMm: prox6h,
				radarAlertLevel: state.alertLevel ?? "monitor",
				// Laranja/push exige evidência CONFIRMADA entre ciclos; o 1º ciclo
				// de um núcleo severo fica no amarelo com motivo explícito.
				radarSevero: severoAgora && severoConfirmado,
				radarSeveroNaoConfirmado: severoAgora && !severoConfirmado,
				radarSeveroCiclos: persistenciaCiclo.ciclosConsecutivos,
				radarKind: state.radarKind ?? null,
				hidroWatch:
					state.hidro?.riscoCheia === "watch" &&
					state.hidro?.desatualizado !== true,
			},
			oficiais,
			{
				// Contexto de transição: o tom do alerta tem que poder DESCER quando
				// o núcleo enfraquece/dissipa (pedido do dono 27/09/2026).
				nivelAnterior: nivelAlertaAnterior,
				nucleoDissipando: nucleoTendencia === "enfraquecendo",
			},
		);
		state.alertaUnificado = unificado;
		logAlertaUnificado(unificado);
		// Livro da dissipação: grava as amostras do ciclo com o nível do alerta.
		// Nunca quebra o ciclo — falha aqui é só log (regra do projeto).
		if (amostrasLivro.length > 0) {
			try {
				const { salvarAmostrasDissipacao } = await import("./db.js");
				for (const a of amostrasLivro) a.nivel = unificado.nivel;
				const gravadas = await salvarAmostrasDissipacao(amostrasLivro);
				logger.info("Livro da dissipação: amostras gravadas", {
					gravadas,
					nivel: unificado.nivel,
				});
			} catch (err) {
				logger.warn("Livro da dissipação falhou (sem quebrar o ciclo)", {
					error: String(err),
				});
			}
		}
		setCachedWeatherState(state);
		// Persistência do CICLO (29/09/2026): grava a evidência severa + o nível
		// final. É o que o próximo ciclo lê para confirmar (ou não) a severidade e
		// para narrar transição de nível mesmo depois de um cold start.
		try {
			await salvarCicloAlerta({
				ts: cicloTs,
				nucleoSevero: severoAgora,
				imediato: imediatoAgora,
				severoConfirmado,
				ciclosConsecutivos: persistenciaCiclo.ciclosConsecutivos,
				maxDbz: vereditoSevero?.cell.maxDbz ?? null,
				distKm: vereditoSevero?.cell.distToTargetKm ?? null,
				tendencia:
					vereditoSevero?.cell.tendencia ??
					vereditoSevero?.cell.movement?.tendencia ??
					null,
				kind: vereditoSevero?.cell.kind ?? state.radarKind ?? null,
				lat: vereditoSevero?.cell.lat ?? null,
				lon: vereditoSevero?.cell.lon ?? null,
				nivel: unificado.nivel,
				motivo: persistenciaCiclo.descricao,
			});
		} catch (err) {
			logger.warn("Ciclo de alerta não foi persistido (sem quebrar o ciclo)", {
				error: String(err),
			});
		}

		// Push no celular (PWA): só laranja/vermelho, com cooldown.
		// Nunca quebra o ciclo — falha de push é só log.
		try {
			const { avisoMovimentoNucleo, pushParaAlerta, sendEventPush } =
				await import("./push.js");
			const regra = pushParaAlerta(unificado.nivel);
			if (regra) {
				// O aviso de olhar o radar entra no corpo do push: o que se aproxima
				// pode mudar de rumo/intensidade (pedido do dono, 27/09/2026).
				// Corpo do push em texto de gente (01/10/2026): a descrição
				// técnica ("núcleo severo confirmado em 2 ciclos") vai pro CARD,
				// não pro celular — lá ela só assusta e não informa.
				const corpoPush = descricaoParaPessoas(unificado);
				const enviado = await sendEventPush(
					regra.evento,
					`${regra.emoji} ${unificado.titulo}`,
					corpoPush,
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

	// Retenção (roda numa janela diária de 20 min, idempotente): o livro e a
	// persistência de ciclos servem para estatística de comportamento, não para
	// auditoria eterna. Antes disso o livro crescia para sempre — a função de
	// limpeza existia e nunca era chamada.
	try {
		const agora = new Date();
		if (agora.getUTCHours() === 4 && agora.getUTCMinutes() < 20) {
			const [amostras, ciclos] = await Promise.all([
				limparAmostrasDissipacaoAntigas(180),
				limparCiclosAlertaAntigos(30),
			]);
			logger.info("Retenção aplicada", { amostrasApagadas: amostras, ciclosApagados: ciclos });
		}
	} catch (err) {
		logger.warn("Retenção falhou (sem quebrar o ciclo)", {
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
