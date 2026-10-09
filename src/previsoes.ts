/**
 * Livro de apostas do monitor (Plano 2, 30/09/2026) — I/O das previsões.
 *
 * O ciclo registra o que o monitor AFIRMOU (com timestamp e janela de
 * desfecho) e a reconciliação depois mede o que ACONTECEU com dado
 * independente. Regras de ouro:
 *
 * - Aposta só se registra UMA vez por evento (chave de dedup + ON CONFLICT).
 * - Desfecho nunca vem do mesmo dado que gerou a previsão: radar afirma →
 *   pluviômetro mede; previsão de restabelecimento → fechamento REAL da
 *   ocorrência na API.
 * - Fechamento de ocorrência só se reconcilia quando a consulta foi
 *   CONFIRMADA (`copelConsultaOk`) — lista vazia de API fora é ignorância,
 *   não "a luz voltou" (mesma regra do checker.ts).
 *
 * As funções de avaliação são puras: src/reconciliacao.ts.
 */
import type { CemadenState } from "./cemaden.js";
import type { AllCheckData } from "./checker.js";
import { getDbClient } from "./db.js";
import { logger } from "./logger.js";
import {
	type Avaliacao,
	avaliarCopelRestabelecimento,
	avaliarEcmwf6h,
	avaliarEtaNucleo,
	avaliarRadarChuva,
	type MedicaoChuva,
	type Previsao,
	type TipoPrevisao,
} from "./reconciliacao.js";
import type { WeatherState } from "./types.js";

/** Limite superior da faixa de duração da Copel (min) quando não há previsão. */
const FAIXA_DURACAO_MIN: Record<string, number> = {
	ate_1h: 60,
	"1h_3h": 180,
	"3h_6h": 360,
	"6h_12h": 720,
	"12h_24h": 1440,
	"24h_48h": 2880,
	mes_48h: 2880,
	mais_48h: 2880,
};

/** "2026-09-30 13:00:00" (horário de Brasília) → epoch ms. */
export function dataBrasiliaParaMs(s: string): number | null {
	const limpo = s.trim().replace(" ", "T");
	const ms = Date.parse(`${limpo}-03:00`);
	return Number.isFinite(ms) ? ms : null;
}

const horaRedonda = (ms: number) => ms - (ms % 3600_000);

// ---------------------------------------------------------------------------
// Medições de pluviômetro (a VERDADE da reconciliação de chuva)
// ---------------------------------------------------------------------------

/**
 * Grava 1 linha por estação por hora (`acc1hr` = acumulado da última hora).
 * É a série que responde "choveu mesmo?" depois da janela da aposta. Nunca
 * lança: o livro não pode derrubar o ciclo.
 */
export async function registrarMedicaoChuva(
	cemaden: CemadenState | null | undefined,
): Promise<void> {
	if (!cemaden?.estacoes?.length) return;
	try {
		const db = await getDbClient();
		const ts = horaRedonda(Date.now());
		await db.batch(
			cemaden.estacoes.map((e) => ({
				sql: `INSERT INTO chuva_medida (ts, estacao, mm1h, stale, atualizado_em)
					VALUES (?, ?, ?, ?, ?)
					ON CONFLICT(estacao, ts) DO UPDATE SET
						mm1h = excluded.mm1h, stale = excluded.stale,
						atualizado_em = excluded.atualizado_em`,
				args: [
					ts,
					String(e.nome || e.idestacao),
					e.acc1hr ?? null,
					e.stale ? 1 : 0,
					Date.now(),
				],
			})),
			"write",
		);
	} catch (err) {
		logger.warn("Falha ao gravar chuva_medida (não crítico)", {
			error: String(err),
		});
	}
}

export async function lerMedicoesChuva(
	desdeMs: number,
): Promise<MedicaoChuva[]> {
	const db = await getDbClient();
	const res = await db.execute({
		sql: "SELECT ts, estacao, mm1h, stale FROM chuva_medida WHERE ts >= ? ORDER BY ts ASC",
		args: [desdeMs],
	});
	return res.rows.map((r) => {
		const row = r as Record<string, unknown>;
		return {
			ts: Number(row.ts),
			estacao: String(row.estacao),
			mm1h: row.mm1h == null ? null : Number(row.mm1h),
			stale: Number(row.stale) === 1,
		} satisfies MedicaoChuva;
	});
}

// ---------------------------------------------------------------------------
// Apostas (tabela `previsoes`)
// ---------------------------------------------------------------------------

export interface NovaPrevisao {
	tipo: TipoPrevisao;
	chave: string;
	registradoEm: number;
	janelaFim: number;
	alvo: Record<string, unknown>;
}

/** Insere se a chave ainda não existe (dedup por evento). Nunca lança. */
export async function registrarPrevisao(p: NovaPrevisao): Promise<boolean> {
	try {
		const db = await getDbClient();
		const res = await db.execute({
			sql: `INSERT INTO previsoes
				(tipo, chave, registrado_em, janela_fim, alvo)
				VALUES (?, ?, ?, ?, ?)
				ON CONFLICT(chave) DO NOTHING`,
			args: [
				p.tipo,
				p.chave,
				p.registradoEm,
				p.janelaFim,
				JSON.stringify(p.alvo),
			],
		});
		return (res.rowsAffected ?? 0) > 0;
	} catch (err) {
		logger.warn("Falha ao registrar previsão (não crítico)", {
			error: String(err),
		});
		return false;
	}
}

export async function lerPrevisoes(
	desdeMs: number,
	tipo?: TipoPrevisao,
): Promise<Previsao[]> {
	const db = await getDbClient();
	const res = tipo
		? await db.execute({
				sql: "SELECT * FROM previsoes WHERE registrado_em >= ? AND tipo = ? ORDER BY registrado_em ASC",
				args: [desdeMs, tipo],
			})
		: await db.execute({
				sql: "SELECT * FROM previsoes WHERE registrado_em >= ? ORDER BY registrado_em ASC",
				args: [desdeMs],
			});
	return res.rows.map((r) => {
		const row = r as Record<string, unknown>;
		let alvo: Record<string, unknown> = {};
		try {
			alvo = JSON.parse(String(row.alvo ?? "{}")) as Record<string, unknown>;
		} catch {
			/* payload antigo/corrompido — segue com objeto vazio */
		}
		let desfecho: Record<string, unknown> | null = null;
		if (row.desfecho != null) {
			try {
				desfecho = JSON.parse(String(row.desfecho)) as Record<string, unknown>;
			} catch {
				desfecho = null;
			}
		}
		return {
			id: Number(row.id),
			tipo: String(row.tipo) as TipoPrevisao,
			chave: String(row.chave),
			registradoEm: Number(row.registrado_em),
			janelaFim: Number(row.janela_fim),
			alvo,
			desfecho,
			avaliadoEm: row.avaliado_em == null ? null : Number(row.avaliado_em),
			acertou: row.acertou == null ? null : Number(row.acertou),
		} satisfies Previsao;
	});
}

/** Grava o desfecho de uma aposta (idempotente). Nunca lança. */
export async function fecharPrevisao(a: Avaliacao): Promise<void> {
	try {
		const db = await getDbClient();
		await db.execute({
			sql: "UPDATE previsoes SET desfecho = ?, avaliado_em = ?, acertou = ? WHERE id = ?",
			args: [JSON.stringify(a.desfecho), Date.now(), a.acertou ? 1 : 0, a.id],
		});
	} catch (err) {
		logger.warn("Falha ao fechar previsão (não crítico)", {
			error: String(err),
		});
	}
}

// ---------------------------------------------------------------------------
// O que o ciclo registra
// ---------------------------------------------------------------------------

/**
 * Registra as apostas do ciclo atual (só o que o monitor está AFIRMANDO agora).
 * Dedup por hora para o alerta de chuva/ETA (evento persistente não abre aposta
 * nova a cada ciclo de 10 min) e por ocorrência para a Copel.
 */
export async function registrarPrevisoesDoCiclo(
	estado: WeatherState,
	checks: AllCheckData,
	agora: number = Date.now(),
): Promise<void> {
	const hora = new Date(horaRedonda(agora)).toISOString().slice(0, 13);

	// ---- radar_chuva + eta_nucleo (o alerta está sendo afirmado AGORA) ----
	const nivel = estado.alertaUnificado?.nivel;
	const afirmandoChuva =
		nivel === "laranja" ||
		nivel === "vermelho" ||
		estado.radarSeveroConfirmado === true;
	if (afirmandoChuva) {
		const ameaca = estado.ameaca ?? null;
		const etaMin = ameaca?.threat?.etaMin ?? null;
		const janelaMin = Math.min(
			240,
			Math.max(90, Math.round((etaMin ?? 60) * 1.8)),
		);
		await registrarPrevisao({
			tipo: "radar_chuva",
			chave: `radar_chuva:${hora}`,
			registradoEm: agora,
			janelaFim: agora + janelaMin * 60_000,
			alvo: {
				nivel: nivel ?? "laranja",
				janelaMin,
				distKm: ameaca?.distToTargetKm ?? null,
				etaMin,
				approach: ameaca?.threat?.approach ?? null,
				maxDbz: ameaca?.maxDbz ?? null,
				tendencia: ameaca?.tendencia ?? null,
				motivos: estado.alertaUnificado?.motivos ?? [],
			},
		});
		if (ameaca?.threat?.approach === "approaching" && etaMin != null) {
			await registrarPrevisao({
				tipo: "eta_nucleo",
				chave: `eta_nucleo:${hora}`,
				registradoEm: agora,
				janelaFim: agora + Math.round(etaMin * 2.5 + 60) * 60_000,
				alvo: {
					etaMin,
					distKm: ameaca?.distToTargetKm ?? null,
					maxDbz: ameaca?.maxDbz ?? null,
				},
			});
		}
	}

	// ---- ecmwf_6h (1x/hora: o que o modelo promete para as próximas 6h) ----
	const prev6h = (estado.hourlyForecast ?? []).slice(0, 6);
	const mmPrevistos =
		Math.round(prev6h.reduce((s, p) => s + (p.precipitationMm ?? 0), 0) * 10) /
		10;
	await registrarPrevisao({
		tipo: "ecmwf_6h",
		chave: `ecmwf_6h:${hora}`,
		registradoEm: agora,
		janelaFim: agora + 6 * 3600_000,
		alvo: {
			mmPrevistos,
			probPct: estado.rainProbabilityPct ?? 0,
			horas: prev6h.map((p) => p.time),
		},
	});

	// ---- copel_restabelecimento (por ocorrência nova com prazo) ----
	for (const o of checks.newCopelOutages) {
		const previsaoMs = o.previsaoRestabelecimento
			? dataBrasiliaParaMs(o.previsaoRestabelecimento)
			: null;
		const faixaMin = FAIXA_DURACAO_MIN[o.faixaDuracao] ?? null;
		if (previsaoMs == null && faixaMin == null) continue;
		const prazoMs =
			previsaoMs != null
				? Math.max(0, previsaoMs - agora)
				: (faixaMin ?? 0) * 60_000;
		await registrarPrevisao({
			tipo: "copel_restabelecimento",
			chave: `copel:${o.idOcorrencia}`,
			registradoEm: agora,
			janelaFim: agora + prazoMs + 2 * 3600_000,
			alvo: {
				idOcorrencia: o.idOcorrencia,
				bairro: o.bairro,
				consumidores: o.qtdConsumidores ?? 0,
				prazoMs,
				previsaoISO:
					previsaoMs != null ? new Date(previsaoMs).toISOString() : null,
				faixaDuracao: o.faixaDuracao ?? null,
			},
		});
	}
}

/**
 * Fecha as apostas de Copel cuja ocorrência SUMIU das ativas (= luz voltou).
 * Chamado a cada ciclo. Só quando `copelConsultaOk` — API fora não fecha nada.
 */
export async function reconciliarFechamentosCopel(
	ativas: { idOcorrencia: string }[],
	consultaOk: boolean,
	agora: number = Date.now(),
): Promise<number> {
	if (!consultaOk) return 0;
	const abertas = (
		await lerPrevisoes(agora - 7 * 24 * 3600_000, "copel_restabelecimento")
	).filter((p) => p.desfecho == null);
	const ativasIds = new Set(ativas.map((o) => o.idOcorrencia));
	let feitas = 0;
	for (const p of abertas) {
		const id = String(p.alvo.idOcorrencia ?? "");
		if (!id || ativasIds.has(id)) continue;
		const aval = avaliarCopelRestabelecimento(p, agora, agora);
		if (aval) {
			await fecharPrevisao(aval);
			feitas++;
		}
	}
	return feitas;
}

/**
 * Reconcilia as apostas cuja janela já fechou (chuva/ETA/ECMWF). Usado pelo
 * endpoint /api/reconciliacao e pelo relatório semanal. Devolve as avaliações
 * gravadas nesta rodada.
 */
export async function reconciliarPendentes(
	agora: number = Date.now(),
): Promise<Avaliacao[]> {
	const desde = agora - 30 * 24 * 3600_000;
	const previsoes = await lerPrevisoes(desde);
	const medidas = await lerMedicoesChuva(desde);
	const feitas: Avaliacao[] = [];

	for (const p of previsoes) {
		if (p.desfecho != null) continue;
		if (p.tipo === "copel_restabelecimento") {
			// Só avalia aqui se já passou do prazo + folga e segue aberta (o
			// fechamento normal acontece no ciclo, quando some da API).
			const aval = avaliarCopelRestabelecimento(p, null, agora);
			if (aval) {
				await fecharPrevisao(aval);
				feitas.push(aval);
			}
			continue;
		}
		if (agora < p.janelaFim) continue; // janela ainda aberta
		const aval =
			p.tipo === "radar_chuva"
				? avaliarRadarChuva(p, medidas)
				: p.tipo === "eta_nucleo"
					? avaliarEtaNucleo(p, medidas)
					: avaliarEcmwf6h(p, medidas);
		await fecharPrevisao(aval);
		feitas.push(aval);
	}
	return feitas;
}
