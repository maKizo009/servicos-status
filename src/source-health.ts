/**
 * Saúde das FONTES do monitor (meta-monitoria, Plano 1 — 30/09/2026).
 *
 * O /health antigo só dizia o estado do MUNDO (Copel/Sanepar) e, pior, em
 * instância fria respondia "degraded" para sempre (lastUnifiedReport vazio =
 * falha silenciosa para quem aponta uptime monitor no endpoint). Este módulo
 * responde a pergunta certa: "o monitor está conseguindo ENXERGAR a realidade?"
 *
 * Uma linha por fonte por ciclo (tabela `source_health`), derivada do estado
 * que o ciclo JÁ calcula — sem instrumentar cada fetch. O vigia externo
 * (fora da Vercel) lê /health e alerta por fonte: "fonte X parou há N min".
 *
 * Regras de derivação (fonte → ok?):
 * - radar_rainviewer: radar.status === "ok" (degraded = fallback de cache).
 * - open_meteo: fetchCurrentWeather não caiu no fallback de defaults
 *   (o fallback INVENTA temperatura — dado fabricado nunca é "ok").
 * - boletim_vlm: texto existe, fonte é de VLM (não heurística) e < 45 min.
 * - cemaden / ana_hidro / alertas_oficiais: sem erro e com leitura fresca.
 * - copel / sanepar: consulta confirmada (lista vazia de consulta falha é
 *   IGNORÂNCIA, não "sem ocorrências" — ver checker.ts).
 */
import { getDbClient } from "./db.js";
import { logger } from "./logger.js";
import type { WeatherState } from "./types.js";

export interface FonteStatus {
	/** Nome estável (chave de upsert): "radar_rainviewer", "copel", ... */
	nome: string;
	/** Rótulo legível pro relatório/alerta. */
	rotulo: string;
	ok: boolean;
	/** Epoch ms da última tentativa de leitura desta fonte. */
	ultimaTentativa: number;
	/** Epoch ms do último sucesso (preservado em falhas). */
	ultimoSucesso: number | null;
	ultimoErro: string | null;
	/** Falhas seguidas (0 = último ciclo ok). Incrementado no SQL. */
	falhasConsecutivas: number;
	detalhe: string | null;
}

/** Fontes de VLM aceitas no boletim (Camada B). Heurística = fallback. */
export const FONTES_VLM = [
	"gemini",
	"openrouter",
	"nvidia_nim_vision",
	"opencode_vision",
	"nvidia_nim",
];

/** Idade máxima de boletim antes de ser considerado velho (min). */
const BOLETIM_IDADE_MAX_MIN = 45;

export interface ChecksResumo {
	copelConsultaOk?: boolean;
	saneparConsultaOk?: boolean;
}

function idadeMin(desde: number | null, agora: number): number | null {
	if (!desde) return null;
	return Math.round((agora - desde) / 60_000);
}

/**
 * Deriva o estado de cada fonte a partir do resultado do ciclo. `estado` pode
 * ser null (instância sem ciclo de clima ainda) — aí só as fontes de serviço
 * (copel/sanepar) entram. Nunca lança.
 */
export function derivarFontes(
	estado: WeatherState | null,
	checks?: ChecksResumo,
	agora: number = Date.now(),
): FonteStatus[] {
	const fontes: FonteStatus[] = [];
	const tentativa = estado?.updatedAt || agora;

	const push = (
		nome: string,
		rotulo: string,
		ok: boolean,
		ultimoSucesso: number | null,
		ultimoErro: string | null,
		detalhe: string | null = null,
	): void => {
		fontes.push({
			nome,
			rotulo,
			ok,
			ultimaTentativa: tentativa,
			ultimoSucesso: ok ? tentativa : ultimoSucesso,
			ultimoErro: ok ? null : ultimoErro,
			falhasConsecutivas: 0, // incrementado no upsert (SQL)
			detalhe,
		});
	};

	if (estado) {
		// ---- Radar (RainViewer) ----
		const radar = estado.radar;
		const radarOk = !!radar && radar.status === "ok";
		push(
			"radar_rainviewer",
			"Radar RainViewer",
			radarOk,
			radar?.lastSuccessTime || null,
			radar?.error ?? (radar ? `status=${radar.status}` : "sem dado de radar"),
			radar && radar.status === "degraded"
				? "servindo cache antigo (fallback)"
				: null,
		);

		// ---- Previsão/tempo atual (Open-Meteo ECMWF) ----
		const om = estado.fonteOpenMeteo;
		const omOk = om ? om.ok : estado.hourlyForecast.length > 0;
		push(
			"open_meteo",
			"Open-Meteo (ECMWF)",
			omOk,
			omOk ? tentativa : null,
			om?.erro ??
				(omOk ? "sem previsão horária" : "fetch falhou — defaults em uso"),
			omOk ? null : "o site mostra temperatura PADRÃO, não medida",
		);

		// ---- Boletim narrativo (Camada B / VLM) ----
		const nb = estado.nowcastBulletin ?? estado.bulletin;
		const nbIdade = nb ? idadeMin(nb.generatedAt, agora) : null;
		const nbFonteOk = !!nb && FONTES_VLM.includes(nb.source);
		const nbFresco = nbIdade !== null && nbIdade <= BOLETIM_IDADE_MAX_MIN;
		push(
			"boletim_vlm",
			"Boletim narrativo (VLM)",
			!!nb && nbFonteOk && nbFresco,
			nb?.generatedAt ?? null,
			!nb
				? "sem boletim no ciclo"
				: !nbFonteOk
					? `fonte "${nb.source}" = fallback heurístico (VLM indisponível)`
					: `boletim com ${nbIdade} min (máx ${BOLETIM_IDADE_MAX_MIN})`,
			nb ? `fonte=${nb.source}` : null,
		);

		// ---- CEMADEN (pluviômetros) ----
		const cem = estado.cemaden;
		const cemOk = !!cem && !cem.erro;
		push(
			"cemaden",
			"Pluviômetros CEMADEN",
			cemOk,
			cem?.atualizadoEm ?? null,
			cem?.erro ?? "sem leitura CEMADEN",
		);

		// ---- ANA Hidro (triangulação do Tibagi) ----
		const hidro = estado.hidro as WeatherState["hidro"] & {
			desatualizado?: boolean;
		};
		const hidroOk = !!hidro && !hidro.erro && hidro.desatualizado !== true;
		push(
			"ana_hidro",
			"ANA Hidro (telemetria)",
			hidroOk,
			hidro?.atualizadoEm ?? null,
			hidro?.erro ??
				(hidro?.desatualizado
					? "ANA fora — mantendo última triangulação boa"
					: "sem triangulação hidro"),
		);

		// ---- Avisos oficiais (INMET / Defesa Civil) — agravante ----
		const oficiais = estado.alertasOficiais;
		const errosOficiais = oficiais?.erros ?? [];
		push(
			"alertas_oficiais",
			"Avisos oficiais (INMET/Defesa Civil)",
			!!oficiais && errosOficiais.length === 0,
			oficiais?.atualizadoEm ?? null,
			errosOficiais.length > 0
				? errosOficiais.join("; ")
				: "sem leitura de avisos oficiais",
		);
	}

	// ---- Serviços (COPEL / Sanepar) — só quando o ciclo de serviços rodou ----
	if (checks) {
		const agoraChecks = checks as {
			timestamp?: number;
			copelConsultaOk?: boolean;
			saneparConsultaOk?: boolean;
		};
		const tsChecks = agoraChecks.timestamp ?? tentativa;
		const copelOk = checks.copelConsultaOk !== false;
		fontes.push({
			nome: "copel",
			rotulo: "API COPEL (energia)",
			ok: copelOk,
			ultimaTentativa: tsChecks,
			ultimoSucesso: copelOk ? tsChecks : null,
			ultimoErro: copelOk ? null : "consulta não confirmada (API fora/timeout)",
			falhasConsecutivas: 0,
			detalhe: null,
		});
		const saneparOk = checks.saneparConsultaOk !== false;
		fontes.push({
			nome: "sanepar",
			rotulo: "Sanepar (água)",
			ok: saneparOk,
			ultimaTentativa: tsChecks,
			ultimoSucesso: saneparOk ? tsChecks : null,
			ultimoErro: saneparOk
				? null
				: "consulta não confirmada (portal fora/timeout)",
			falhasConsecutivas: 0,
			detalhe: null,
		});
	}

	return fontes;
}

/**
 * Upsert por fonte no Turso + memória da instância. `falhas_consecutivas`
 * incrementa no SQL quando o ciclo falha e zera quando volta — sobrevive a
 * cold start. Nunca lança (o heartbeat não pode derrubar o ciclo).
 */
export async function salvarSourceHealth(fontes: FonteStatus[]): Promise<void> {
	if (fontes.length === 0) return;
	try {
		const db = await getDbClient();
		await db.batch(
			fontes.map((f) => ({
				sql: `INSERT INTO source_health
					(nome, rotulo, ok, ultima_tentativa, ultimo_sucesso, ultimo_erro,
					 falhas_consecutivas, detalhe, atualizado_em)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(nome) DO UPDATE SET
					rotulo = excluded.rotulo,
					ok = excluded.ok,
					ultima_tentativa = excluded.ultima_tentativa,
					ultimo_sucesso = CASE
						WHEN excluded.ok = 1 THEN excluded.ultima_tentativa
						ELSE source_health.ultimo_sucesso END,
					ultimo_erro = excluded.ultimo_erro,
					falhas_consecutivas = CASE
						WHEN excluded.ok = 1 THEN 0
						ELSE source_health.falhas_consecutivas + 1 END,
					detalhe = excluded.detalhe,
					atualizado_em = excluded.atualizado_em`,
				args: [
					f.nome,
					f.rotulo,
					f.ok ? 1 : 0,
					f.ultimaTentativa,
					f.ultimoSucesso,
					f.ultimoErro,
					// 1ª falha já conta 1 (o ramo de conflito faz o +1 das seguidas)
					f.ok ? 0 : Math.max(1, f.falhasConsecutivas),
					f.detalhe,
					Date.now(),
				],
			})),
			"write",
		);
		cacheMemoria = { ts: Date.now(), fontes: await lerSourceHealthSemCache() };
	} catch (err) {
		logger.warn("Falha ao gravar source_health (heartbeat)", {
			error: String(err),
		});
	}
}

let cacheMemoria: { ts: number; fontes: FonteStatus[] } | null = null;
const CACHE_TTL_MS = 30_000;

/** Lê as fontes do Turso sem passar pelo cache (uso interno). */
async function lerSourceHealthSemCache(): Promise<FonteStatus[]> {
	const db = await getDbClient();
	const res = await db.execute("SELECT * FROM source_health ORDER BY nome ASC");
	return res.rows.map((r) => {
		const row = r as Record<string, unknown>;
		return {
			nome: String(row.nome),
			rotulo: String(row.rotulo ?? row.nome),
			ok: Number(row.ok) === 1,
			ultimaTentativa: Number(row.ultima_tentativa ?? 0),
			ultimoSucesso:
				row.ultimo_sucesso == null ? null : Number(row.ultimo_sucesso),
			ultimoErro: row.ultimo_erro == null ? null : String(row.ultimo_erro),
			falhasConsecutivas: Number(row.falhas_consecutivas ?? 0),
			detalhe: row.detalhe == null ? null : String(row.detalhe),
		} satisfies FonteStatus;
	});
}

/**
 * Estado das fontes para o /health — cache de 30 s (o endpoint não tem rate
 * limit e é chamado por healthcheck; não vale um SELECT por ping).
 */
export async function lerSourceHealth(): Promise<FonteStatus[]> {
	if (cacheMemoria && Date.now() - cacheMemoria.ts < CACHE_TTL_MS) {
		return cacheMemoria.fontes;
	}
	try {
		const fontes = await lerSourceHealthSemCache();
		cacheMemoria = { ts: Date.now(), fontes };
		return fontes;
	} catch (err) {
		logger.warn("Falha ao ler source_health", { error: String(err) });
		return cacheMemoria?.fontes ?? [];
	}
}

export interface SaudeMonitor {
	/** "unknown" = nunca teve ciclo gravado; "degraded" = alguma fonte cega. */
	status: "healthy" | "degraded" | "unknown";
	problemas: string[];
	/** Idade do ciclo mais recente (s) — null sem histórico. */
	dataAgeSec: number | null;
}

/**
 * Saúde DO MONITOR (não do mundo): "degraded" = ele não está conseguindo
 * enxergar alguma fonte, ou o ciclo parou. O estado do mundo (Copel sem luz)
 * continua no `level` do /health — são perguntas diferentes.
 */
export function avaliarSaudeMonitor(
	fontes: FonteStatus[],
	agora: number = Date.now(),
): SaudeMonitor {
	if (fontes.length === 0) {
		return { status: "unknown", problemas: [], dataAgeSec: null };
	}
	const problemas: string[] = [];
	for (const f of fontes.filter((x) => !x.ok)) {
		const desde = idadeMin(f.ultimoSucesso, agora);
		problemas.push(
			`${f.rotulo}: ${f.ultimoErro ?? "falha"} (${
				desde === null
					? "sem sucesso conhecido"
					: `último sucesso há ${desde} min`
			}; ${f.falhasConsecutivas} falhas seguidas)`,
		);
	}
	const maisRecente = Math.max(...fontes.map((f) => f.ultimaTentativa));
	const dataAgeSec = Math.max(0, Math.round((agora - maisRecente) / 1000));
	// Ciclo parado: nenhum heartbeat novo em 25 min (ciclo oficial = 10 min).
	if (dataAgeSec > 25 * 60) {
		problemas.push(
			`ciclo parado há ${Math.round(dataAgeSec / 60)} min (sem heartbeat das fontes)`,
		);
	}
	return {
		status: problemas.length > 0 ? "degraded" : "healthy",
		problemas,
		dataAgeSec,
	};
}
