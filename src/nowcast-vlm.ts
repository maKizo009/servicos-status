import { PNG } from "pngjs";
import { loadConfig } from "./config.js";
import { getMunicipioComFallback } from "./geo-municipio.js";
import { logger } from "./logger.js";
import type { NowcastResult } from "./radar-analysis.js";
import {
	assessThreat,
	fetchTileGrid,
	haversineKm,
	normalizeRegion,
	projectCell,
	type RegionSpec,
	type ThreatVerdict,
} from "./radar-analysis.js";

/**
 * Camada B — Análise não-determinística (VLM via NVIDIA NIM).
 *
 * Recebe os números da Camada A (nowcast determinístico) + o composite
 * visual dos frames de radar e pede ao VLM (Llama 3.2 Vision) um boletim
 * narrativo em português: cor dos núcleos, direção de deslocamento e se
 * há chuva vindo para Ipiranga.
 *
 * O LLM NUNCA é a fonte dos números (isso é a Camada A); ele interpreta
 * e redige a partir dos dados + imagem. Fallback para heurística se o
 * VLM falhar ou não houver chave NIM configurada.
 */

const FRAMES_IN_COMPOSITE = 3;

/**
 * Contexto da previsão numérica ECMWF (Open-Meteo) — fonte de médio prazo,
 * concatenada com o nowcast para a decisão probabilística do VLM.
 */
export interface EcmwfContext {
	rainProbabilityPct: number;
	hourlyForecast: {
		time: string;
		tempC: number;
		rainProbabilityPct: number;
		precipitationMm: number;
	}[];
}

export interface NowcastBulletin {
	text: string;
	source: "nvidia_nim_vision" | "heuristic";
	generatedAt: number;
}

/**
 * Monta um composite PNG dos frames de radar da região (mosaico reduzido).
 * Cada frame vira uma "coluna" do composite; mosaicos grandes (grid z=9)
 * são reduzidos para no máximo COMPOSITE_MAX_PX por lado (nearest-neighbor)
 * para não explodir o payload do VLM.
 */
const COMPOSITE_MAX_PX = 512;

export async function buildRadarComposite(
	host: string,
	pastFrames: { time: number; path: string }[],
	region: RegionSpec,
): Promise<{ dataUrl: string; width: number; height: number } | null> {
	const frames = pastFrames.slice(-FRAMES_IN_COMPOSITE);
	if (frames.length === 0) return null;

	const norm = normalizeRegion(region);
	const frameW = Math.min(norm.width, COMPOSITE_MAX_PX);
	const frameH = Math.min(norm.height, COMPOSITE_MAX_PX);
	const width = frameW * frames.length;
	const height = frameH;
	const composite = new PNG({ width, height });

	for (let i = 0; i < frames.length; i++) {
		try {
			const mosaic = await fetchTileGrid(host, frames[i].path, norm);
			// redimensiona (nearest-neighbor) o mosaico para frameW x frameH
			for (let y = 0; y < frameH; y++) {
				for (let x = 0; x < frameW; x++) {
					const sx = Math.min(
						Math.floor((x / frameW) * norm.width),
						norm.width - 1,
					);
					const sy = Math.min(
						Math.floor((y / frameH) * norm.height),
						norm.height - 1,
					);
					const srcIdx = (sy * norm.width + sx) * 4;
					const dstIdx = (y * width + (i * frameW + x)) * 4;
					composite.data[dstIdx] = mosaic.data[srcIdx];
					composite.data[dstIdx + 1] = mosaic.data[srcIdx + 1];
					composite.data[dstIdx + 2] = mosaic.data[srcIdx + 2];
					composite.data[dstIdx + 3] = mosaic.data[srcIdx + 3];
				}
			}
		} catch (err) {
			logger.warn("Camada B: falha ao baixar frame para composite", {
				path: frames[i].path,
				error: String(err),
			});
		}
	}

	const buf = PNG.sync.write(composite);
	const dataUrl = `data:image/png;base64,${buf.toString("base64")}`;
	return { dataUrl, width, height };
}

/**
 * Gera o boletim narrativo do nowcast usando o VLM da NVIDIA NIM.
 * Prompt em pt-BR pedindo análise visual dos tons + números da Camada A.
 */
export async function generateNowcastBulletin(
	nowcast: NowcastResult,
	host: string,
	pastFrames: { time: number; path: string }[],
	region: RegionSpec,
	ecmwf?: EcmwfContext,
): Promise<NowcastBulletin> {
	const config = loadConfig();
	const apiKey = config.nvidiaNimApiKey;

	// Sem chave NIM → fallback heurístico (não faz sentido chamar VLM)
	if (!apiKey) {
		return {
			text: buildHeuristicBulletin(nowcast, ecmwf),
			source: "heuristic",
			generatedAt: Date.now(),
		};
	}

	try {
		const composite = await buildRadarComposite(host, pastFrames, region);
		if (!composite) {
			return {
				text: buildHeuristicBulletin(nowcast, ecmwf),
				source: "heuristic",
				generatedAt: Date.now(),
			};
		}

		const m = nowcast.movement;
		const dirs = ["N", "NE", "L", "SE", "S", "SO", "O", "NO"];
		const dirLabel = m ? dirs[Math.round(m.directionDeg / 45) % 8] : null;
		const intensityLabel: Record<string, string> = {
			light: "fraca",
			moderate: "moderada",
			heavy: "forte",
			extreme: "muito forte (temporal)",
		};

		// Localização determinística do núcleo (município real via malha IBGE —
		// point-in-polygon). O VLM NUNCA calcula isso, apenas repete o dado fornecido.
		const cell = nowcast.nearestCell;
		let locationNote = "";
		let threatNote = "";
		// Veredito determinístico exposto para validação pós-geração (Achado 2).
		let verdict: ThreatVerdict | null = null;
		if (cell && typeof cell.lat === "number") {
			const { municipio, fallbackUsado } = getMunicipioComFallback(
				cell.lat,
				cell.lon,
				haversineKm,
			);
			const ipirangaKm = haversineKm(cell.lat, cell.lon, -25.0244, -50.5847);
			const nome =
				municipio?.nome ?? `(${cell.lat.toFixed(2)}, ${cell.lon.toFixed(2)})`;
			const metodo = fallbackUsado
				? " (referência regional — fora da malha IBGE)"
				: "";
			locationNote = `- Núcleo mais intenso em (${cell.lat.toFixed(2)}, ${cell.lon.toFixed(2)}): município ${nome}${metodo}; dista ${Math.round(ipirangaKm)} km de Ipiranga\n`;

			// Veredicto de ameaça DETERMINÍSTICO (Camada A): o VLM nunca decide
			// se o núcleo vem ou não para Ipiranga — recebe a conclusão pronta.
			if (m) {
				verdict = assessThreat(cell.lat, cell.lon, m, -25.0244, -50.5847);
				const approachLabel: Record<ThreatVerdict["approach"], string> = {
					approaching: `APROXIMANDO-SE de Ipiranga (ETA ~${Math.round(verdict.etaMin ?? 0)} min, se mantiver curso e intensidade)`,
					receding:
						"AFASTANDO-SE de Ipiranga (trajetória leva para longe — risco direto para Ipiranga é praticamente nulo)",
					crossing:
						"em trajetória tangencial a Ipiranga (passa de raspão, sem aproximação direta)",
				};
				threatNote = `- VEREDITO DE AMEAÇA (cálculo determinístico, NÃO contradiga): o núcleo está ${approachLabel[verdict.approach]}\n`;

				// Projeção da trajetória: em quais municípios o núcleo estará
				// em 30/60/120 min (extrapolação linear). As "próximas cidades".
				const projections = [30, 60, 120]
					.map((t) => {
						const p = projectCell(cell.lat, cell.lon, m, t);
						const pm = getMunicipioComFallback(p.lat, p.lon, haversineKm);
						return { t, ...p, nome: pm.municipio?.nome ?? null };
					})
					.filter((p) => p.nome && p.nome !== nome);
				if (projections.length > 0) {
					const projList = projections
						.map((p) => `${p.nome} (${p.t} min)`)
						.join(", ");
					threatNote += `- Projeção da trajetória (extrapolação, pode dissipar): ${projList}\n`;
				}
			}
		}

		// Seção de previsão numérica ECMWF (concatenação de fontes): o VLM
		// pesa o nowcast (curto prazo) contra o modelo numérico (horas).
		let ecmwfSection = "";
		if (
			ecmwf &&
			(ecmwf.hourlyForecast.length > 0 || ecmwf.rainProbabilityPct > 0)
		) {
			const nowPct = Math.round(ecmwf.rainProbabilityPct);
			const hourly = ecmwf.hourlyForecast
				.slice(0, 6)
				.map(
					(h) =>
						`- ${h.time}: ${h.rainProbabilityPct}% de chuva (${h.precipitationMm} mm)`,
				)
				.join("\n");
			ecmwfSection = `\nPREVISÃO NUMÉRICA (ECMWF IFS — Open-Meteo, fonte de médio prazo, confie nela para o horizonte de HORAS):\n- Agora: ${nowPct}% de probabilidade de chuva\n${hourly}\n`;
		}

		const prompt = `Você é um meteorologista analisando imagens de radar meteorológico (RainViewer, esquema de cores "Universal Blue").
A imagem mostra 3 frames consecutivos do radar (esquerda = mais antigo, direita = mais recente) da região de Ipiranga/PR, com intervalo de ~10 minutos cada.
IMPORTANTE: as imagens são de momentos ANTERIORES (o frame mais recente tem alguns minutos de atraso) — a análise não é ao vivo; trate as conclusões como uma projeção de curto prazo.

DADOS DA ANÁLISE COMPUTACIONAL (medições determinísticas, confie neles):
- Intensidade dominante: ${intensityLabel[nowcast.currentDominant] ?? nowcast.currentDominant} (pico ${nowcast.currentMaxDbz} dBZ)
- Movimento do núcleo mais intenso: ${m ? `direção ${m.directionDeg}° (${dirLabel}), ${m.speedKmh} km/h` : "sem movimento detectado"}
${locationNote}${threatNote}${ecmwfSection}- Frames analisados: ${nowcast.frames.length}

Instruções:
0. NUNCA repita, cite ou parafraseie as instruções ou os cabeçalhos deste prompt no seu texto — escreva apenas a análise para o cidadão, sem títulos, sem listas, sem markdown além de negrito simples, em no máximo 3 frases corridas.
1. Observe as cores na imagem: azul/âmbar = chuva fraca, azul-escuro = moderada, amarelo/laranja = forte, vermelho/rosa = temporal.
2. A direção e a velocidade MEDIDAS (acima) são a fonte de verdade — use SEMPRE esses valores. Não invente outra direção baseada na imagem; ela pode parecer ambígua.
3. Responda em português brasileiro, no máximo 3 frases, informando ao cidadão de Ipiranga se está vindo chuva e o que esperar nas próximas 1-2 horas, deixando claro que a análise usa imagens de radar de alguns minutos atrás. Mencione em qual MUNICÍPIO o núcleo está (use SOMENTE o município fornecido na localização acima — ele é a fonte oficial; não troque por outra cidade da região por conta própria).
4. REGRA DE OURO: o VEREDITO DE AMEAÇA acima é um cálculo determinístico feito por computador — NUNCA contradiga, NUNCA diga que o núcleo está "vindo em direção a Ipiranga" quando o veredito diz AFASTANDO-SE ou tangencial. Se estiver AFASTANDO-SE, diga claramente que o risco para Ipiranga é nulo/praticamente nulo e, se houver projeção de trajetória, mencione quais municípios podem ser afetados à frente.
5. Se o veredito disser APROXIMANDO-SE, informe o ETA fornecido e alerte com seriedade, mas SEM alarmismo e mencionando a incerteza (pode dissipar ou mudar de rumo).
6. Se o núcleo estiver distante (mais de 80 km) ou o movimento estiver ausente/não confiável (sem valor medido), diga que não há alerta iminente ou que a trajetória é incerta — não invente direção, velocidade ou ETA.
7. Seja honesto sobre a incerteza: nowcast de curto prazo pode cometer erros (dissipação ou mudança súbita de rumo) — mencione isso de forma natural quando houver risco.
8. CONCILIAÇÃO DE FONTES: a PREVISÃO NUMÉRICA (ECMWF) cobre o horizonte de horas e o nowcast o curto prazo. Se o ECMWF indicar probabilidade alta de chuva (>=50%) mas o radar NÃO mostrar núcleos significativos, NÃO diga que "vai chover" nem que "não vai chover" como certeza — diga que o modelo numérico indica X% de chance de chuva nas próximas horas, mas o radar não mostra núcleos no momento (condição de observação estável). Se o ECMWF indicar baixa probabilidade mas o radar mostrar núcleo se aproximando, prevalece o nowcast (radar) para o curto prazo, mas mencione que o modelo numérico vê baixa chance — é sinal de célula isolada que pode dissipar.

NÃO invente números além dos fornecidos. Seja direto e útil.`;

		// Tenta o modelo vision 90B (mais capaz) e cai para o 11B (mais rápido)
		// se o primeiro falhar/timeout — o free tier da NIM tem fila e o 90B
		// frequentemente estoura timeouts curtos.
		const visionModels = [
			"meta/llama-3.2-90b-vision-instruct",
			"meta/llama-3.2-11b-vision-instruct",
		];

		for (const model of visionModels) {
			try {
				const response = await fetch(config.nvidiaNimEndpoint, {
					method: "POST",
					headers: {
						Authorization: `Bearer ${apiKey}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						model,
						messages: [
							{
								role: "user",
								content: [
									{ type: "text", text: prompt },
									{
										type: "image_url",
										image_url: { url: composite.dataUrl },
									},
								],
							},
						],
						max_tokens: 300,
						temperature: 0.4,
					}),
					signal: AbortSignal.timeout(90_000),
				});

				if (!response.ok) {
					logger.warn("Camada B: NIM vision HTTP", {
						model,
						status: response.status,
					});
					continue;
				}

				const json = (await response.json()) as {
					choices?: Array<{ message?: { content?: string } }>;
				};
				const text = json.choices?.[0]?.message?.content?.trim();
				if (!text) {
					logger.warn("Camada B: NIM vision retornou vazio", { model });
					continue;
				}

				// Validação pós-geração (Achado 2 + conciliação): o texto NUNCA
				// pode contradizer a Camada A, ignorar o ECMWF (>=50%) ou
				// regurgitar o prompt. Se reprovar, tenta o próximo modelo;
				// no fim cai na heurística.
				if (!validateBulletinAgainstVerdict(text, verdict, ecmwf)) {
					logger.warn("Camada B: texto rejeitado pela validação", {
						model,
					});
					continue;
				}

				logger.info("Camada B: boletim nowcast gerado via NIM vision", {
					model,
				});
				return { text, source: "nvidia_nim_vision", generatedAt: Date.now() };
			} catch (err) {
				logger.warn("Camada B: NIM vision falhou, tentando próximo modelo", {
					model,
					error: String(err),
				});
			}
		}

		// Todos os modelos vision falharam → fallback determinístico
		logger.warn(
			"Camada B: todos os modelos vision falharam, usando heurística",
		);
		return {
			text: buildHeuristicBulletin(nowcast),
			source: "heuristic",
			generatedAt: Date.now(),
		};
	} catch (err) {
		logger.warn("Camada B: VLM falhou no composite/prompt, usando heurística", {
			error: String(err),
		});
		return {
			text: buildHeuristicBulletin(nowcast),
			source: "heuristic",
			generatedAt: Date.now(),
		};
	}
}

/**
 * Valida o texto gerado pelo VLM contra o veredito determinístico (Achado 2)
 * e contra a previsão numérica ECMWF (conciliação de fontes).
 * O LLM NUNCA é a fonte dos números; se o texto contradiz a Camada A, ignora
 * o ECMWF ou regurgita o prompt, é descartado e cai no fallback heurístico.
 * Retorna true quando o texto é aceitável.
 */
export function validateBulletinAgainstVerdict(
	text: string,
	verdict: ThreatVerdict | null,
	ecmwf?: EcmwfContext,
): boolean {
	// 1. Regurgitação de instruções do prompt: frases que NUNCA devem aparecer
	// no texto de saída (o modelo copiou o prompt em vez de responder).
	const promptLeaks =
		/(fonte de verdade|não invente|regra de ouro|medições determinísticas|confie neles|veredito de ameaça|análise computacional|nunca contradiga|instruções:|esquema de cores "universal blue")/i;
	if (promptLeaks.test(text)) {
		logger.warn("Camada B: texto rejeitado (regurgitação do prompt)", { text });
		return false;
	}

	// 2. Padrões de prompt injection / instruções embutidas no texto gerado.
	if (
		/(ignore|esqueça|esqueca|desconsidere|system prompt|instru(?:ções|coes).*(?:anterior|acima)|você agora é|a partir de agora)/i.test(
			text,
		)
	) {
		logger.warn("Camada B: texto rejeitado (padrões de injection)", { text });
		return false;
	}

	if (!verdict) return true;

	const lower = text.toLowerCase();

	// 2. Veredito AFASTANDO-SE/tangencial mas o texto sugere aproximação.
	if (verdict.approach !== "approaching") {
		const hasNegation =
			/(não|nada|nulo|praticamente nulo|sem risco|afastando|de raspão|tangencial)/i.test(
				lower,
			);
		const saysApproaching =
			/(aproximando|vindo (?:em direção|para)|chegando|rumo a|em direção a|atingir|alcançar)/i.test(
				lower,
			);
		if (saysApproaching && !hasNegation) {
			logger.warn(
				"Camada B: texto contradiz veredito (aproximação vs afastamento)",
				{ verdict: verdict.approach, text },
			);
			return false;
		}
	}

	// 3. Veredito APROXIMANDO-SE: qualquer ETA citado deve bater com o
	// calculado (tolerância de 35% — o caso real "196 min vs 1-2 horas" cai
	// fora disso e é rejeitado). Compostos "X horas e Y min" contam como um
	// único valor (ex: "3 horas e 15 minutos" = 195 min, não 3h E 15min).
	if (verdict.approach === "approaching" && verdict.etaMin != null) {
		const minutes: number[] = [];
		const consumed: Array<[number, number]> = [];
		for (const cm of text.matchAll(
			/(\d{1,2})\s*(?:horas?|h)\s*e\s+(\d{1,3})\s*(?:min|minutos?)\b/gi,
		)) {
			const total = Number(cm[1]) * 60 + Number(cm[2]);
			if (Number.isFinite(total) && total > 0) minutes.push(total);
			consumed.push([cm.index ?? 0, (cm.index ?? 0) + cm[0].length]);
		}
		const isConsumed = (idx: number): boolean =>
			consumed.some(([s, e]) => idx >= s && idx < e);
		for (const hh of text.matchAll(/(\d{1,2})\s*(?:horas?|h)\b/gi)) {
			if (isConsumed(hh.index ?? 0)) continue;
			const v = Number(hh[1]) * 60;
			if (Number.isFinite(v) && v > 0) minutes.push(v);
		}
		for (const mm of text.matchAll(/(\d{1,3})\s*(?:min|minutos?)\b/gi)) {
			if (isConsumed(mm.index ?? 0)) continue;
			const v = Number(mm[1]);
			if (Number.isFinite(v) && v > 0) minutes.push(v);
		}
		for (const c of minutes) {
			if (!Number.isFinite(c) || c <= 0) continue;
			const ratio = Math.abs(c - verdict.etaMin) / verdict.etaMin;
			if (ratio > 0.35) {
				logger.warn("Camada B: ETA citado diverge do cálculo determinístico", {
					etaVlm: c,
					etaCalc: Math.round(verdict.etaMin),
					ratio,
					text,
				});
				return false;
			}
		}
	}

	// 4. (Reconciliado com o Dave) O ECMWF NÃO é gate de aceitação: para o
	// horizonte de 1-2h o radar (nowcast) é a fonte da verdade — um boletim
	// que prioriza o radar e diz "sem alerta iminente" mesmo com ECMWF >=50%
	// é comportamento CORRETO. O ECMWF fica no prompt apenas como orientação
	// de redação (regra 8), não como critério de rejeição.

	return true;
}

/** Fallback determinístico quando o VLM não está disponível */
function buildHeuristicBulletin(
	nowcast: NowcastResult,
	ecmwf?: EcmwfContext,
): string {
	const m = nowcast.movement;
	const dirs = ["N", "NE", "L", "SE", "S", "SO", "O", "NO"];
	const dirLabel = m ? dirs[Math.round(m.directionDeg / 45) % 8] : null;
	const intensityLabel: Record<string, string> = {
		light: "fraca",
		moderate: "moderada",
		heavy: "forte",
		extreme: "muito forte (temporal)",
	};

	// Conciliação de fontes: nowcast (curto prazo) + ECMWF (horas).
	const ecmwfPct = ecmwf ? Math.round(ecmwf.rainProbabilityPct) : null;
	const ecmwfNote =
		ecmwfPct != null && ecmwfPct > 0
			? ` O modelo ECMWF indica ${ecmwfPct}% de chance de chuva nas próximas horas${
					ecmwfPct >= 50 && (!m || m.speedKmh <= 1)
						? ", mas o radar não mostra núcleos em movimento no momento (condição estável)."
						: "."
				}`
			: "";

	// Sem movimento confiável (ausente OU velocidade ~0 = célula estacionária).
	if (!m || m.speedKmh <= 1) {
		if (!m) {
			return `Sem núcleos de chuva significativos em movimento na região de Ipiranga no momento.${ecmwfNote}`;
		}
		return `Núcleo de chuva ${intensityLabel[nowcast.currentDominant] ?? nowcast.currentDominant} (pico ${nowcast.currentMaxDbz} dBZ) presente na região, mas sem movimento significativo detectado (estacionário).${ecmwfNote}`;
	}

	return `Núcleo de chuva ${intensityLabel[nowcast.currentDominant] ?? nowcast.currentDominant} (pico ${nowcast.currentMaxDbz} dBZ) deslocando-se para ${dirLabel} a ${m.speedKmh} km/h. Observação baseada em ${m.intervalMin} min de frames de radar.${ecmwfNote}`;
}
