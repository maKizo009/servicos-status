import {
	type Client,
	createClient as createWebClient,
} from "@libsql/client/web";
import type { AmostraNucleo } from "./dissipacao.js";
import type { CicloEvidenciaSevera } from "./persistencia-alerta.js";
import { logger } from "./logger.js";
import type {
	WeatherBulletin,
	WeatherRadarData,
} from "./types.js";

let client: Client | null = null;

export async function getDbClient(): Promise<Client> {
	if (!client) {
		// Sem fallback hardcoded: a URL do banco de produção estava escrita no
		// código de um repo PÚBLICO e, se a env faltasse, o app conectava em
		// silêncio num host fixo (achado pentest 26/09/2026). Agora falha claro.
		const tursoUrl = process.env.TURSO_DATABASE_URL || process.env.TURSO_URL;
		if (!tursoUrl) {
			throw new Error(
				"TURSO_DATABASE_URL ausente: configure a env (o fallback hardcoded foi removido em 26/09/2026)",
			);
		}
		const tursoToken =
			process.env.TURSO_AUTH_TOKEN ||
			process.env.TURSO_DATABASE_TOKEN ||
			process.env.TURSO_AUTH_KEY;

		logger.info("Connecting to Turso Cloud SQLite database via Web Client", {
			url: tursoUrl,
		});
		client = createWebClient({
			url: tursoUrl,
			authToken: tursoToken,
		});
	}
	return client;
}

export async function initDb(): Promise<Client> {
	const db = await getDbClient();

	try {
		await db.batch(
			[
				`CREATE TABLE IF NOT EXISTS known_events (
				source TEXT NOT NULL,
				hash TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				PRIMARY KEY (source, hash)
			)`,
				`CREATE TABLE IF NOT EXISTS event_history (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				source TEXT NOT NULL,
				title TEXT NOT NULL,
				bairro TEXT DEFAULT '',
				details TEXT DEFAULT '',
				consumers INTEGER DEFAULT 0,
				timestamp INTEGER NOT NULL
			)`,
				`CREATE TABLE IF NOT EXISTS weather_radar_cache (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				host TEXT NOT NULL,
				version TEXT NOT NULL,
				payload TEXT NOT NULL,
				status TEXT NOT NULL,
				last_success_time INTEGER NOT NULL,
				timestamp INTEGER NOT NULL
			)`,
				`CREATE TABLE IF NOT EXISTS weather_bulletins (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				bulletin TEXT NOT NULL,
				source TEXT NOT NULL,
				generated_at INTEGER NOT NULL
			)`,
				`CREATE TABLE IF NOT EXISTS weather_nowcast_bulletins (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					text TEXT NOT NULL,
					source TEXT NOT NULL,
					generated_at INTEGER NOT NULL,
					context_key TEXT
				)`,
				`CREATE TABLE IF NOT EXISTS weather_state_cache (
				id INTEGER PRIMARY KEY CHECK (id = 1),
				payload TEXT NOT NULL,
				updated_at INTEGER NOT NULL
			)`,
				`CREATE TABLE IF NOT EXISTS push_subscriptions (
				endpoint TEXT PRIMARY KEY,
				p256dh TEXT NOT NULL,
				auth TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				last_seen_at INTEGER NOT NULL
			)`,
				`CREATE TABLE IF NOT EXISTS push_sent (
					evento TEXT PRIMARY KEY,
					enviado_at INTEGER NOT NULL
				)`,
				// Livro da dissipação: uma linha por núcleo relevante por ciclo.
				// Serve para medir a hipótese do dono ("essas chuvas se dissipam
				// conforme chegam aqui") com dado do próprio radar, em vez de
				// impressão visual. Ver src/dissipacao.ts.
				`CREATE TABLE IF NOT EXISTS radar_dissipacao (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					medido_em INTEGER NOT NULL,
					lat REAL NOT NULL,
					lon REAL NOT NULL,
					dist_km REAL NOT NULL,
					max_dbz REAL NOT NULL,
					intensity TEXT NOT NULL,
					kind TEXT NOT NULL,
					isolado INTEGER,
					frames_vivo INTEGER,
					delta_dbz REAL,
					tendencia TEXT,
					approach TEXT,
					eta_min REAL,
					zona TEXT NOT NULL,
					nivel TEXT,
					chuva_1h_mm REAL,
					chuva_6h_mm REAL
				)`,
				`CREATE INDEX IF NOT EXISTS idx_radar_dissipacao_medido
					ON radar_dissipacao (medido_em)`,
				// Persistência da evidência severa entre ciclos (29/09/2026): uma
				// linha por CICLO de radar (id = ts do frame analisado). Sem isto o
				// alerta era recalculado do zero e uma aparição isolada de núcleo
				// promovia laranja/push por 10 min. Ver src/persistencia-alerta.ts.
				// Também é a memória do NÍVEL do ciclo anterior (o cache em memória
				// morre no cold start da Vercel e a narração de subida/queda ficava
				// sem referência).
				`CREATE TABLE IF NOT EXISTS radar_alerta_ciclos (
					ciclo_ts INTEGER PRIMARY KEY,
					avaliado_em INTEGER NOT NULL,
					nucleo_severo INTEGER NOT NULL,
					imediato INTEGER NOT NULL,
					severo_confirmado INTEGER NOT NULL,
					ciclos_consecutivos INTEGER,
					max_dbz REAL,
					dist_km REAL,
					tendencia TEXT,
					kind TEXT,
					lat REAL,
					lon REAL,
					nivel TEXT,
					motivo TEXT
				)`,
				`CREATE INDEX IF NOT EXISTS idx_radar_alerta_ciclos_avaliado
					ON radar_alerta_ciclos (avaliado_em)`,
				// Heartbeat por fonte (meta-monitoria, 30/09/2026): uma linha por
			// fonte, atualizada a cada ciclo. É o que permite ao vigia externo
			// dizer "a fonte X parou há N minutos" em vez de "o site tá velho".
			// Ver src/source-health.ts.
			`CREATE TABLE IF NOT EXISTS source_health (
					nome TEXT PRIMARY KEY,
					rotulo TEXT NOT NULL,
					ok INTEGER NOT NULL,
					ultima_tentativa INTEGER NOT NULL,
					ultimo_sucesso INTEGER,
					ultimo_erro TEXT,
					falhas_consecutivas INTEGER NOT NULL DEFAULT 0,
					detalhe TEXT,
					atualizado_em INTEGER NOT NULL
				)`,
			// Livro de apostas (Plano 2, 30/09/2026): cada afirmação verificável
			// do monitor (alerta de chuva, ETA, previsão ECMWF, restabelecimento
			// Copel) vira aposta registrada com janela de desfecho; a
			// reconciliação mede depois com dado independente (pluviômetro /
			// fechamento real da ocorrência). Ver src/previsoes.ts e
			// src/reconciliacao.ts.
			`CREATE TABLE IF NOT EXISTS previsoes (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					tipo TEXT NOT NULL,
					chave TEXT NOT NULL UNIQUE,
					registrado_em INTEGER NOT NULL,
					janela_fim INTEGER NOT NULL,
					alvo TEXT NOT NULL,
					desfecho TEXT,
					avaliado_em INTEGER,
					acertou INTEGER
				)`,
			`CREATE INDEX IF NOT EXISTS idx_previsoes_tipo ON previsoes(tipo)`,
			`CREATE INDEX IF NOT EXISTS idx_previsoes_registrado ON previsoes(registrado_em)`,
			// A VERDADE da reconciliação de chuva: 1 linha/estação/hora com o
			// acumulado da última hora (acc1hr do CEMADEN). Sem esta série não
			// existe "choveu mesmo?" depois da janela da aposta.
			`CREATE TABLE IF NOT EXISTS chuva_medida (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					ts INTEGER NOT NULL,
					estacao TEXT NOT NULL,
					mm1h REAL,
					stale INTEGER NOT NULL DEFAULT 0,
					atualizado_em INTEGER NOT NULL,
					UNIQUE(estacao, ts)
				)`,
			`CREATE INDEX IF NOT EXISTS idx_chuva_medida_ts ON chuva_medida(ts)`,
			`CREATE TABLE IF NOT EXISTS app_events (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				tipo TEXT NOT NULL,
				session_id TEXT,
				ts INTEGER NOT NULL
			)`,
				// Dedup de instalação: 1 evento 'install' por dispositivo (session_id).
				// Sem isso, cada abertura do app em modo standalone contava +1 install
				// (achado 2026-08-12 — número de instalações inflado no painel).
				// ATENÇÃO (21/09/2026): o índice único abaixo FALHA se o banco já tiver
				// installs duplicados de antes de 12/08 — e como isto roda em batch, a
				// falha derrubava o init INTEIRO do schema ("Failed to initialize
				// Database schema", SQLITE_CONSTRAINT UNIQUE app_events.session_id).
				// Limpar antes, mantendo o install MAIS ANTIGO de cada sessão. É
				// idempotente: sem duplicados o DELETE não apaga nada.
				`DELETE FROM app_events
				WHERE tipo = 'install' AND session_id IS NOT NULL
				  AND id NOT IN (
					SELECT MIN(id) FROM app_events
					WHERE tipo = 'install' AND session_id IS NOT NULL
					GROUP BY session_id
				  )`,
				`CREATE UNIQUE INDEX IF NOT EXISTS idx_app_events_install_once
				ON app_events(session_id) WHERE tipo='install'`,
				`CREATE TABLE IF NOT EXISTS app_sessions (
				session_id TEXT PRIMARY KEY,
				first_seen INTEGER NOT NULL,
				last_seen INTEGER NOT NULL
			)`,
				`CREATE TABLE IF NOT EXISTS webauthn_credentials (
				id TEXT PRIMARY KEY,
				public_key TEXT NOT NULL,
				counter INTEGER NOT NULL DEFAULT 0,
				transports TEXT DEFAULT '[]',
				created_at INTEGER NOT NULL
			)`,
				`CREATE TABLE IF NOT EXISTS webauthn_challenges (
				challenge TEXT PRIMARY KEY,
				email TEXT NOT NULL,
				purpose TEXT NOT NULL,
				ts INTEGER NOT NULL
			)`,
				"CREATE INDEX IF NOT EXISTS idx_known_events_source ON known_events(source)",
				"CREATE INDEX IF NOT EXISTS idx_event_history_timestamp ON event_history(timestamp)",
				"CREATE INDEX IF NOT EXISTS idx_weather_bulletins_generated ON weather_bulletins(generated_at)",
				"CREATE INDEX IF NOT EXISTS idx_weather_nowcast_bulletins_generated ON weather_nowcast_bulletins(generated_at)",
				"CREATE INDEX IF NOT EXISTS idx_app_events_ts ON app_events(ts)",
				"CREATE INDEX IF NOT EXISTS idx_app_events_tipo ON app_events(tipo)",
				"CREATE INDEX IF NOT EXISTS idx_app_sessions_last_seen ON app_sessions(last_seen)",
			],
			"write",
		);

		// Índices de tabelas que o batch NÃO cria (connectivity_results, bgp_results
		// e signal_reports vieram de versões anteriores; em banco novo elas não
		// existem). Dentro do batch, um único erro derruba o init INTEIRO — o
		// libSQL roda batch em transação, então NENHUMA tabela era criada e o
		// schema ficava "initialized" no log sem ter criado nada (achado
		// 26/09/2026: banco local novo subia só com as tabelas criaadas sob
		// demanda). Fora do batch, cada um falha sozinho e o init sobrevive.
		for (const sql of [
			"CREATE INDEX IF NOT EXISTS idx_connectivity_timestamp ON connectivity_results(timestamp)",
			"CREATE INDEX IF NOT EXISTS idx_bgp_timestamp ON bgp_results(timestamp)",
			"CREATE INDEX IF NOT EXISTS idx_signal_reports_expires ON signal_reports(expires_at)",
		]) {
			try {
				await db.execute(sql);
			} catch {
				// tabela legada ausente neste banco — segue o jogo
			}
		}

		// Migração idempotente (22/09/2026): bancos criados antes desta data não têm
		// a coluna context_key. Ela é a impressão do CENÁRIO do boletim — sem ela o
		// gate de reuso volta a comparar só tempo, e o texto congelava com timestamp
		// novo a cada ciclo (ver llm-bulletin.ts e o incidente do "Boletim IA").
		try {
			await db.execute(
				"ALTER TABLE weather_nowcast_bulletins ADD COLUMN context_key TEXT",
			);
		} catch {
			// coluna já existe — caminho normal nas execuções seguintes
		}

		logger.info(
			"Database schema initialized successfully via LibSQL Web batch",
		);
	} catch (err) {
		logger.error("Failed to initialize Database schema", {
			error: String(err),
		});
	}

	return db;
}


export interface EventLogItem {
	id: number;
	source: string;
	title: string;
	bairro: string;
	details: string;
	consumers: number;
	timestamp: number;
}

export async function saveEventLog(
	source: string,
	title: string,
	bairro = "",
	details = "",
	consumers = 0,
): Promise<void> {
	const db = await getDbClient();
	await db.execute({
		sql: "INSERT INTO event_history (source, title, bairro, details, consumers, timestamp) VALUES (?, ?, ?, ?, ?, ?)",
		args: [source, title, bairro, details, consumers, Date.now()],
	});
}

/**
 * Últimos eventos de um serviço (copel/sanepar), do mais recente ao mais antigo,
 * dentro da janela. É a MEMÓRIA dos avisos: o card de Serviços mostrava só o
 * estado instantâneo, então um push recebido não deixava rastro nenhum na página
 * depois que a luz voltava (o dono recebeu push de 24 UCs e o site dizia
 * "Nenhuma interrupção ativa" — 28/09/2026).
 */
export async function getRecentEvents(
	source: string,
	sinceMs: number,
	limit = 5,
): Promise<EventLogItem[]> {
	const db = await getDbClient();
	const res = await db.execute({
		sql: "SELECT id, source, title, bairro, details, consumers, timestamp FROM event_history WHERE source = ? AND timestamp >= ? ORDER BY timestamp DESC LIMIT ?",
		args: [source, sinceMs, limit],
	});
	return res.rows.map((r: Record<string, unknown>) => ({
		id: Number(r.id),
		source: String(r.source),
		title: String(r.title),
		bairro: String(r.bairro ?? ""),
		details: String(r.details ?? ""),
		consumers: Number(r.consumers ?? 0),
		timestamp: Number(r.timestamp),
	}));
}

export async function getDailyStatsSummary() {
	const db = await getDbClient();
	const now = Date.now();
	const startOfDay = now - (now % (24 * 60 * 60 * 1000));
	const startOf7Days = now - 7 * 86400 * 1000;

	const copelTodayRes = await db.execute({
		sql: "SELECT COUNT(*) as cnt, COALESCE(SUM(consumers), 0) as totalConsumers FROM event_history WHERE source = 'copel' AND timestamp >= ?",
		args: [startOfDay],
	});
	const copelTodayRow = copelTodayRes.rows[0] as Record<string, unknown>;

	const copel7DaysRes = await db.execute({
		sql: "SELECT COUNT(*) as cnt FROM event_history WHERE source = 'copel' AND timestamp >= ?",
		args: [startOf7Days],
	});
	const copel7DaysRow = copel7DaysRes.rows[0] as Record<string, unknown>;

	const saneparTodayRes = await db.execute({
		sql: "SELECT COUNT(*) as cnt FROM event_history WHERE source = 'sanepar' AND timestamp >= ?",
		args: [startOfDay],
	});
	const saneparTodayRow = saneparTodayRes.rows[0] as Record<string, unknown>;

	const sanepar7DaysRes = await db.execute({
		sql: "SELECT COUNT(*) as cnt FROM event_history WHERE source = 'sanepar' AND timestamp >= ?",
		args: [startOf7Days],
	});
	const sanepar7DaysRow = sanepar7DaysRes.rows[0] as Record<string, unknown>;

	const telemetryTodayRes = await db.execute({
		sql: "SELECT COUNT(*) as cnt FROM telemetry_logs WHERE timestamp >= ?",
		args: [startOfDay],
	});
	const telemetryTodayRow = telemetryTodayRes.rows[0] as Record<
		string,
		unknown
	>;

	const logsRes = await db.execute(
		"SELECT id, source, title, bairro, details, consumers, timestamp FROM event_history ORDER BY timestamp DESC LIMIT 30",
	);

	const recentLogs: EventLogItem[] = logsRes.rows.map(
		(r: Record<string, unknown>) => ({
			id: Number(r.id),
			source: String(r.source),
			title: String(r.title),
			bairro: String(r.bairro ?? ""),
			details: String(r.details ?? ""),
			consumers: Number(r.consumers ?? 0),
			timestamp: Number(r.timestamp),
		}),
	);

	return {
		todayStart: startOfDay,
		copel: {
			eventsToday: Number(copelTodayRow?.cnt || 0),
			totalConsumersToday: Number(copelTodayRow?.totalConsumers || 0),
			events7Days: Number(copel7DaysRow?.cnt || 0),
		},
		sanepar: {
			eventsToday: Number(saneparTodayRow?.cnt || 0),
			events7Days: Number(sanepar7DaysRow?.cnt || 0),
		},
		telemetry: {
			testsToday: Number(telemetryTodayRow?.cnt || 0),
		},
		recentLogs,
	};
}

export async function saveRadarCache(data: WeatherRadarData): Promise<void> {
	const db = await getDbClient();
	const payload = JSON.stringify(data);
	await db.execute({
		sql: "INSERT INTO weather_radar_cache (host, version, payload, status, last_success_time, timestamp) VALUES (?, ?, ?, ?, ?, ?)",
		args: [
			data.host,
			data.version,
			payload,
			data.status,
			data.lastSuccessTime,
			Date.now(),
		],
	});
}

/**
 * Grava uma AMOSTRA por núcleo relevante do ciclo (livro da dissipação).
 * Devolve quantas linhas entrou. Nunca lança por si: quem chama trata.
 */
export async function salvarAmostrasDissipacao(
	amostras: AmostraNucleo[],
): Promise<number> {
	if (amostras.length === 0) return 0;
	const db = await getDbClient();
	await db.batch(
		amostras.map((a) => ({
			sql: "INSERT INTO radar_dissipacao (medido_em, lat, lon, dist_km, max_dbz, intensity, kind, isolado, frames_vivo, delta_dbz, tendencia, approach, eta_min, zona, nivel, chuva_1h_mm, chuva_6h_mm) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			args: [
				a.medidoEm,
				a.lat,
				a.lon,
				a.distKm,
				a.maxDbz,
				a.intensity,
				a.kind,
				a.isolado === null ? null : a.isolado ? 1 : 0,
				a.framesVivo,
				a.deltaDbz,
				a.tendencia,
				a.approach,
				a.etaMin,
				a.zona,
				a.nivel,
				a.chuva1hMm,
				a.chuva6hMm,
			],
		})),
		"write",
	);
	return amostras.length;
}

/**
 * Apaga amostras mais antigas que `dias` (retenção padrão: 180 dias — o livro
 * serve para estatística de comportamento, não para auditoria eterna).
 */
export async function limparAmostrasDissipacaoAntigas(
	dias = 180,
): Promise<number> {
	const db = await getDbClient();
	const limite = Date.now() - dias * 24 * 3600_000;
	const res = await db.execute({
		sql: "DELETE FROM radar_dissipacao WHERE medido_em < ?",
		args: [limite],
	});
	return res.rowsAffected ?? 0;
}

/** Lê as amostras do livro desde `desdeMs` (ordem cronológica). */
export async function lerAmostrasDissipacao(
	desdeMs: number,
	limite = 20000,
): Promise<AmostraNucleo[]> {
	const db = await getDbClient();
	const res = await db.execute({
		sql: "SELECT * FROM radar_dissipacao WHERE medido_em >= ? ORDER BY medido_em ASC LIMIT ?",
		args: [desdeMs, limite],
	});
	return res.rows.map((r) => {
		const row = r as Record<string, unknown>;
		return {
			medidoEm: Number(row.medido_em),
			lat: Number(row.lat),
			lon: Number(row.lon),
			distKm: Number(row.dist_km),
			maxDbz: Number(row.max_dbz),
			intensity: String(row.intensity),
			kind: String(row.kind),
			isolado: row.isolado === null ? null : Number(row.isolado) === 1,
			framesVivo: row.frames_vivo === null ? null : Number(row.frames_vivo),
			deltaDbz: row.delta_dbz === null ? null : Number(row.delta_dbz),
			tendencia: row.tendencia === null ? null : String(row.tendencia),
			approach: row.approach === null ? null : String(row.approach),
			etaMin: row.eta_min === null ? null : Number(row.eta_min),
			zona: String(row.zona),
			nivel: row.nivel === null ? null : String(row.nivel),
			chuva1hMm: row.chuva_1h_mm === null ? null : Number(row.chuva_1h_mm),
			chuva6hMm: row.chuva_6h_mm === null ? null : Number(row.chuva_6h_mm),
		};
	});
}

/** Linha da persistência, com o que o ciclo decidiu (auditoria). */
export interface RegistroCicloAlerta extends CicloEvidenciaSevera {
	lat?: number | null;
	lon?: number | null;
	/** Evidência severa confirmada pela série de ciclos (libera laranja/push) */
	severoConfirmado: boolean;
	ciclosConsecutivos?: number | null;
}

/**
 * Grava (ou regrava) a linha do CICLO de radar. O id é o timestamp do frame
 * analisado: o cron pode rodar mais de uma vez no mesmo frame — nesse caso a
 * linha é ATUALIZADA, não duplicada (senão a contagem de ciclos consecutivos
 * mentiria). Nunca lança por si: quem chama trata.
 */
export async function salvarCicloAlerta(
	registro: RegistroCicloAlerta,
): Promise<void> {
	const db = await getDbClient();
	await db.execute({
		sql: `INSERT INTO radar_alerta_ciclos
			(ciclo_ts, avaliado_em, nucleo_severo, imediato, severo_confirmado,
			 ciclos_consecutivos, max_dbz, dist_km, tendencia, kind, lat, lon, nivel, motivo)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(ciclo_ts) DO UPDATE SET
				avaliado_em = excluded.avaliado_em,
				nucleo_severo = excluded.nucleo_severo,
				imediato = excluded.imediato,
				severo_confirmado = excluded.severo_confirmado,
				ciclos_consecutivos = excluded.ciclos_consecutivos,
				max_dbz = excluded.max_dbz,
				dist_km = excluded.dist_km,
				tendencia = excluded.tendencia,
				kind = excluded.kind,
				lat = excluded.lat,
				lon = excluded.lon,
				nivel = excluded.nivel,
				motivo = excluded.motivo`,
		args: [
			registro.ts,
			Date.now(),
			registro.nucleoSevero ? 1 : 0,
			registro.imediato ? 1 : 0,
			registro.severoConfirmado ? 1 : 0,
			registro.ciclosConsecutivos ?? null,
			registro.maxDbz ?? null,
			registro.distKm ?? null,
			registro.tendencia ?? null,
			registro.kind ?? null,
			registro.lat ?? null,
			registro.lon ?? null,
			registro.nivel ?? null,
			registro.motivo ?? null,
		],
	});
}

/** Lê os ciclos desde `desdeMs` (ordem cronológica — o avaliador espera isso). */
export async function lerCiclosAlerta(
	desdeMs: number,
	limite = 500,
): Promise<CicloEvidenciaSevera[]> {
	const db = await getDbClient();
	const res = await db.execute({
		sql: "SELECT * FROM radar_alerta_ciclos WHERE ciclo_ts >= ? ORDER BY ciclo_ts ASC LIMIT ?",
		args: [desdeMs, limite],
	});
	return res.rows.map((r) => {
		const row = r as Record<string, unknown>;
		return {
			ts: Number(row.ciclo_ts),
			nucleoSevero: Number(row.nucleo_severo) === 1,
			imediato: Number(row.imediato) === 1,
			maxDbz: row.max_dbz === null ? null : Number(row.max_dbz),
			distKm: row.dist_km === null ? null : Number(row.dist_km),
			tendencia: row.tendencia === null ? null : String(row.tendencia),
			kind: row.kind === null ? null : String(row.kind),
			nivel: row.nivel === null ? null : String(row.nivel),
			motivo: row.motivo === null ? null : String(row.motivo),
		} satisfies CicloEvidenciaSevera;
	});
}

/**
 * Nível do alerta no último ciclo gravado. Substitui o cache em memória como
 * referência da narração de subida/queda: em serverless o cache morre no cold
 * start e o texto saía sem saber que o nível tinha descido.
 */
export async function lerUltimoNivelAlerta(): Promise<string | null> {
	const db = await getDbClient();
	const res = await db.execute(
		"SELECT nivel FROM radar_alerta_ciclos WHERE nivel IS NOT NULL ORDER BY ciclo_ts DESC LIMIT 1",
	);
	return res.rows.length === 0 ? null : String(res.rows[0]?.nivel ?? "") || null;
}

/** Retenção dos ciclos (padrão 30 dias: serve à continuidade, não à auditoria). */
export async function limparCiclosAlertaAntigos(dias = 30): Promise<number> {
	const db = await getDbClient();
	const limite = Date.now() - dias * 24 * 3600_000;
	const res = await db.execute({
		sql: "DELETE FROM radar_alerta_ciclos WHERE avaliado_em < ?",
		args: [limite],
	});
	return res.rowsAffected ?? 0;
}

export async function getLatestRadarCache(): Promise<WeatherRadarData | null> {
	const db = await getDbClient();
	const res = await db.execute(
		"SELECT payload, status, last_success_time FROM weather_radar_cache ORDER BY timestamp DESC LIMIT 1",
	);
	if (res.rows.length === 0) return null;
	const row = res.rows[0] as Record<string, unknown>;

	try {
		const parsed = JSON.parse(String(row.payload)) as WeatherRadarData;
		parsed.status = String(row.status) as "ok" | "degraded" | "down";
		parsed.lastSuccessTime = Number(row.last_success_time);
		return parsed;
	} catch {
		return null;
	}
}



export async function getLatestWeatherBulletin(): Promise<WeatherBulletin | null> {
	const db = await getDbClient();
	const res = await db.execute(
		"SELECT id, bulletin, source, generated_at as generatedAt FROM weather_bulletins ORDER BY generated_at DESC LIMIT 1",
	);
	if (res.rows.length === 0) return null;
	const row = res.rows[0] as Record<string, unknown>;

	return {
		id: Number(row.id),
		bulletin: String(row.bulletin),
		source: row.source as "nvidia_nim" | "gemini" | "heuristic",
		generatedAt: Number(row.generatedAt),
	};
}

export interface NowcastBulletinRecord {
	id: number;
	text: string;
	source:
		| "opencode_vision"
		| "gemini"
		| "nvidia_nim_vision"
		| "heuristic"
		| "openrouter"
		| "nvidia_nim";
	generatedAt: number;
	/** Impressão do cenário que gerou o texto (null em boletins antigos). */
	contextKey?: string | null;
}

export async function saveNowcastBulletin(
	text: string,
	source:
		| "opencode_vision"
		| "gemini"
		| "nvidia_nim_vision"
		| "heuristic"
		| "openrouter"
		| "nvidia_nim",
	contextKey?: string | null,
): Promise<NowcastBulletinRecord> {
	const now = Date.now();
	const db = await getDbClient();
	const res = await db.execute({
		sql: "INSERT INTO weather_nowcast_bulletins (text, source, generated_at, context_key) VALUES (?, ?, ?, ?)",
		args: [text, source, now, contextKey ?? null],
	});
	return {
		id: Number(res.lastInsertRowid ?? now),
		text,
		source,
		generatedAt: now,
		contextKey: contextKey ?? null,
	};
}

export async function getLatestNowcastBulletin(): Promise<NowcastBulletinRecord | null> {
	const db = await getDbClient();
	const res = await db.execute(
		"SELECT id, text, source, generated_at as generatedAt, context_key as contextKey FROM weather_nowcast_bulletins ORDER BY generated_at DESC LIMIT 1",
	);
	if (res.rows.length === 0) return null;
	const row = res.rows[0] as Record<string, unknown>;

	return {
		id: Number(row.id),
		text: String(row.text),
		source: row.source as
			| "opencode_vision"
			| "nvidia_nim_vision"
			| "gemini"
			| "heuristic"
			| "openrouter"
			| "nvidia_nim",
		generatedAt: Number(row.generatedAt),
		contextKey: row.contextKey == null ? null : String(row.contextKey),
	};
}

export interface WeatherStateCacheRecord {
	payload: string;
	updatedAt: number;
}

/**
 * Persiste o WeatherState completo (JSON) no Turso — o cache compartilhado
 * entre instâncias serverless. O cron (/api/cron) grava a cada 10 min; os
 * endpoints /api/weather e /llms.txt leem daqui SEM regenerar o ciclo VLM
 * inline (achado 2026-08-15: instância fria rodava o sync completo e o
 * visitante esperava 60s+).
 */
export async function saveWeatherStateCache(payload: string): Promise<void> {
	const db = await getDbClient();
	await db.execute({
		sql: "INSERT INTO weather_state_cache (id, payload, updated_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at",
		args: [payload, Date.now()],
	});
}

export async function getWeatherStateCache(): Promise<WeatherStateCacheRecord | null> {
	const db = await getDbClient();
	const res = await db.execute(
		"SELECT payload, updated_at as updatedAt FROM weather_state_cache WHERE id = 1",
	);
	if (res.rows.length === 0) return null;
	const row = res.rows[0] as Record<string, unknown>;
	return {
		payload: String(row.payload),
		updatedAt: Number(row.updatedAt),
	};
}

export function closeDb(): void {
	if (client) {
		try {
			client.close();
		} catch {}
		client = null;
	}
}
