/**
 * Reconciliação de previsões (Plano 2 da meta-monitoria, 30/09/2026).
 *
 * O monitor afirma coisas verificáveis o tempo todo ("chuva em ~40 min",
 * "energia volta até 13:00", "4,6 mm nas próximas 6h"). Aqui cada afirmação
 * vira uma APPOSTA registrada com timestamp, e o desfecho é medido DEPOIS
 * com dado independente da afirmação (pluviômetro / fechamento real da
 * ocorrência) — nunca com o mesmo dado que gerou a previsão.
 *
 * Métricas duras do boletim semanal: falso positivo (alertou e não choveu),
 * falso negativo (choveu e não alertou), erro de ETA (min), erro de mm do
 * ECMWF e atraso do restabelecimento da Copel. É o que transforma "acredite
 * no monitor" em "olha os números dele".
 *
 * Só funções PURAS aqui (sem fetch/sem banco) — testáveis em
 * scripts/test-reconciliacao.ts. O I/O vive em src/previsoes.ts.
 */
import { CHUVA_SIGNIFICATIVA_MM } from "./dissipacao.js";

export type TipoPrevisao =
	| "radar_chuva"
	| "eta_nucleo"
	| "ecmwf_6h"
	| "copel_restabelecimento";

export interface MedicaoChuva {
	ts: number;
	estacao: string;
	/** Acumulado da última hora (mm). null = estação sem reporte. */
	mm1h: number | null;
	/** Leitura velha demais: NÃO vale como "sem chuva" (nem como chuva). */
	stale: boolean;
}

export interface Previsao {
	id: number;
	tipo: TipoPrevisao;
	/** Chave de dedup (ex.: "copel:1-26B47938"). */
	chave: string;
	registradoEm: number;
	/** Fim da janela em que o desfecho ainda conta. */
	janelaFim: number;
	/** O que foi afirmado (JSON por tipo — ver registrarPrevisoesDoCiclo). */
	alvo: Record<string, unknown>;
	desfecho: Record<string, unknown> | null;
	avaliadoEm: number | null;
	acertou: number | null;
}

export interface Avaliacao {
	id: number;
	tipo: TipoPrevisao;
	acertou: boolean;
	desfecho: Record<string, unknown>;
}

/** Tolerância do ETA: |erro| ≤ max(30 min, 40% do ETA prometido). */
export function toleranciaEtaMin(etaPrevistoMin: number): number {
	return Math.max(30, Math.abs(etaPrevistoMin) * 0.4);
}

/** Soma medida de chuva (mm) em (t0, t1], ignorando leituras stale. */
export function chuvaNaJanela(
	medidas: MedicaoChuva[],
	t0: number,
	t1: number,
): number {
	let soma = 0;
	for (const m of medidas) {
		if (m.stale || m.mm1h == null) continue;
		if (m.ts > t0 && m.ts <= t1) soma += m.mm1h;
	}
	return Math.round(soma * 10) / 10;
}

/**
 * Eventos de chuva (p/ falso negativo): sequências de medições ≥ limiar com
 * gap ≤ 2h contam como UM evento. Horas isoladas de garoa não viram 5 FN.
 */
export function eventosDeChuva(
	medidas: MedicaoChuva[],
	limiarMm = CHUVA_SIGNIFICATIVA_MM,
): { inicio: number; fim: number; mmTotal: number }[] {
	const validas = medidas
		.filter((m) => !m.stale && m.mm1h != null && m.mm1h >= limiarMm)
		.sort((a, b) => a.ts - b.ts);
	const eventos: { inicio: number; fim: number; mmTotal: number }[] = [];
	for (const m of validas) {
		const atual = eventos[eventos.length - 1];
		if (atual && m.ts - atual.fim <= 2 * 3600_000) {
			atual.fim = m.ts;
			atual.mmTotal = Math.round((atual.mmTotal + (m.mm1h ?? 0)) * 10) / 10;
		} else {
			eventos.push({ inicio: m.ts, fim: m.ts, mmTotal: m.mm1h ?? 0 });
		}
	}
	return eventos;
}

/** Falsos NEGATIVOS: eventos de chuva que NENHUMA aposta de radar cobriu. */
export function falsosNegativos(
	medidas: MedicaoChuva[],
	previsoes: Previsao[],
): { inicio: number; mmTotal: number }[] {
	const coberturas = previsoes
		.filter((p) => p.tipo === "radar_chuva")
		.map((p) => ({ t0: p.registradoEm, t1: p.janelaFim }));
	return eventosDeChuva(medidas)
		.filter((ev) => {
			// Evento coberto = começa dentro da janela de alguma aposta.
			const coberto = coberturas.some(
				(c) => ev.inicio >= c.t0 - 30 * 60_000 && ev.inicio <= c.t1,
			);
			return !coberto;
		})
		.map((ev) => ({ inicio: ev.inicio, mmTotal: ev.mmTotal }));
}

/**
 * radar_chuva: "chuva significativa (≥0,2 mm) medida na região dentro da
 * janela". Verdade = pluviômetro (independente do radar que gerou a aposta).
 */
export function avaliarRadarChuva(
	prev: Previsao,
	medidas: MedicaoChuva[],
): Avaliacao {
	const mm = chuvaNaJanela(medidas, prev.registradoEm, prev.janelaFim);
	return {
		id: prev.id,
		tipo: prev.tipo,
		acertou: mm >= CHUVA_SIGNIFICATIVA_MM,
		desfecho: {
			mmMedidos: mm,
			mmMinimos: CHUVA_SIGNIFICATIVA_MM,
			janelaMin: Math.round((prev.janelaFim - prev.registradoEm) / 60_000),
		},
	};
}

/**
 * eta_nucleo: "chove em ~etaMin minutos". Mede quando a chuva REALMENTE
 * começou (1ª medição ≥0,2 mm na janela) e compara. Núcleo que prometeu chegar
 * e não chegou vira acertou=false com chegou:false (falso alarme, não erro de
 * ETA — são coisas diferentes e o relatório separa).
 */
export function avaliarEtaNucleo(
	prev: Previsao,
	medidas: MedicaoChuva[],
): Avaliacao {
	const etaPrevisto = Number(prev.alvo.etaMin ?? 0);
	const candidatas = medidas
		.filter(
			(m) =>
				!m.stale &&
				m.mm1h != null &&
				m.mm1h >= CHUVA_SIGNIFICATIVA_MM &&
				m.ts > prev.registradoEm &&
				m.ts <= prev.janelaFim,
		)
		.sort((a, b) => a.ts - b.ts);
	const primeira = candidatas[0];
	if (!primeira) {
		return {
			id: prev.id,
			tipo: prev.tipo,
			acertou: false,
			desfecho: {
				etaPrevistoMin: etaPrevisto,
				chegou: false,
				motivo: "não mediu chuva na janela — núcleo não chegou",
			},
		};
	}
	const realMin = Math.round((primeira.ts - prev.registradoEm) / 60_000);
	const erroMin = realMin - etaPrevisto;
	const tol = toleranciaEtaMin(etaPrevisto);
	return {
		id: prev.id,
		tipo: prev.tipo,
		acertou: Math.abs(erroMin) <= tol,
		desfecho: {
			etaPrevistoMin: etaPrevisto,
			etaRealMin: realMin,
			erroMin,
			toleranciaMin: Math.round(tol),
			chegou: true,
		},
	};
}

/**
 * ecmwf_6h: evento = ≥1 mm em 6h (ou probabilidade ≥60% como previsão de
 * evento). Acertou = acertou o EVENTO; o erro de mm sai junto (o modelo pode
 * acertar o evento e errar a quantidade).
 */
export function avaliarEcmwf6h(
	prev: Previsao,
	medidas: MedicaoChuva[],
): Avaliacao {
	const mmPrevisto = Number(prev.alvo.mmPrevistos ?? 0);
	const prob = Number(prev.alvo.probPct ?? 0);
	const mmMedidos = chuvaNaJanela(
		medidas,
		prev.registradoEm,
		prev.registradoEm + 6 * 3600_000,
	);
	const eventoPrevisto = mmPrevisto >= 1 || prob >= 60;
	const eventoMedido = mmMedidos >= 1;
	return {
		id: prev.id,
		tipo: prev.tipo,
		acertou: eventoPrevisto === eventoMedido,
		desfecho: {
			mmPrevistos: mmPrevisto,
			probPct: prob,
			mmMedidos,
			erroMm: Math.round((mmMedidos - mmPrevisto) * 10) / 10,
			eventoPrevisto,
			eventoMedido,
		},
	};
}

/**
 * copel_restabelecimento: "energia volta até <prazo>". `fechadoEm` = quando a
 * ocorrência sumiu da API (null = ainda ativa). Sem fechamento, só é avaliada
 * depois do prazo + 2h de folga (senão seria chute).
 */
export function avaliarCopelRestabelecimento(
	prev: Previsao,
	fechadoEm: number | null,
	agora: number,
): Avaliacao | null {
	const prazoMs = Number(prev.alvo.prazoMs ?? 0);
	if (fechadoEm != null) {
		const atrasoMin = Math.round(
			(fechadoEm - (prev.registradoEm + prazoMs)) / 60_000,
		);
		return {
			id: prev.id,
			tipo: prev.tipo,
			acertou: fechadoEm <= prev.registradoEm + prazoMs,
			desfecho: {
				fechadoEm,
				prazoMs,
				atrasoMin: Math.max(0, atrasoMin),
				aindaAtiva: false,
			},
		};
	}
	if (agora > prev.registradoEm + prazoMs + 2 * 3600_000) {
		return {
			id: prev.id,
			tipo: prev.tipo,
			acertou: false,
			desfecho: {
				prazoMs,
				atrasoMin: Math.round((agora - (prev.registradoEm + prazoMs)) / 60_000),
				aindaAtiva: true,
				motivo: "ocorrência segue ativa além do prazo",
			},
		};
	}
	return null; // ainda dentro do prazo — decidir depois
}

export interface ResumoAcuracia {
	apostas: number;
	avaliadas: number;
	pendentes: number;
	acertos: number;
	precisaoPct: number | null;
	falsosPositivos: number;
	falsosNegativos: number;
	erroMedioEtaMin: number | null;
	erroMedioMmEcmwf: number | null;
	atrasoMedioCopelMin: number | null;
	porTipo: Record<
		string,
		{
			total: number;
			avaliadas: number;
			acertos: number;
			precisaoPct: number | null;
		}
	>;
}

export function agregarAcuracia(
	previsoes: Previsao[],
	avaliacoes: Avaliacao[],
	fn: { inicio: number; mmTotal: number }[],
): ResumoAcuracia {
	const porTipo: ResumoAcuracia["porTipo"] = {};
	const addTipo = (tipo: string) =>
		(porTipo[tipo] ??= {
			total: 0,
			avaliadas: 0,
			acertos: 0,
			precisaoPct: null,
		});

	for (const p of previsoes) {
		const t = addTipo(p.tipo);
		t.total++;
	}
	for (const a of avaliacoes) {
		const t = addTipo(a.tipo);
		t.avaliadas++;
		if (a.acertou) t.acertos++;
	}
	for (const t of Object.values(porTipo)) {
		t.precisaoPct =
			t.avaliadas > 0 ? Math.round((t.acertos / t.avaliadas) * 100) : null;
	}

	const avaliadas = avaliacoes.length;
	const acertos = avaliacoes.filter((a) => a.acertou).length;
	const errosEta = avaliacoes
		.filter((a) => a.tipo === "eta_nucleo" && a.desfecho.chegou === true)
		.map((a) => Math.abs(Number(a.desfecho.erroMin ?? 0)));
	const errosMm = avaliacoes
		.filter((a) => a.tipo === "ecmwf_6h")
		.map((a) => Math.abs(Number(a.desfecho.erroMm ?? 0)));
	const atrasosCopel = avaliacoes
		.filter(
			(a) =>
				a.tipo === "copel_restabelecimento" &&
				a.desfecho.aindaAtiva !== true &&
				Number(a.desfecho.atrasoMin ?? 0) > 0,
		)
		.map((a) => Number(a.desfecho.atrasoMin ?? 0));
	const media = (xs: number[]) =>
		xs.length > 0
			? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length)
			: null;

	return {
		apostas: previsoes.length,
		avaliadas,
		pendentes: previsoes.length - avaliacoes.length,
		acertos,
		precisaoPct: avaliadas > 0 ? Math.round((acertos / avaliadas) * 100) : null,
		// FP = alerta de chuva/ETA que não virou chuva (avaliado acertou=false).
		falsosPositivos: avaliacoes.filter(
			(a) =>
				!a.acertou && (a.tipo === "radar_chuva" || a.tipo === "eta_nucleo"),
		).length,
		falsosNegativos: fn.length,
		erroMedioEtaMin: media(errosEta),
		erroMedioMmEcmwf: media(errosMm),
		atrasoMedioCopelMin: media(atrasosCopel),
		porTipo,
	};
}

/** Boletim semanal (PT-BR, monoespaçado) — entregue verbatim pelo cron. */
export function formatarRelatorioAcuracia(
	resumo: ResumoAcuracia,
	dias: number,
	medicoesChuva?: number,
): string {
	const pct = (v: number | null) => (v == null ? "—" : `${v}%`);
	const num = (v: number | null) => (v == null ? "—" : String(v));
	const linhas: string[] = [];
	linhas.push(`🎯 Boletim de acurácia — últimos ${dias} dias`);
	linhas.push(
		`   apostas: ${resumo.apostas} · avaliadas: ${resumo.avaliadas} · precisão geral: ${pct(resumo.precisaoPct)} · pendentes: ${resumo.pendentes}`,
	);
	if (medicoesChuva != null) {
		linhas.push(`   medições de pluviômetro (a verdade): ${medicoesChuva}`);
	}
	linhas.push("");
	// Linha de seção: com desfecho mostra os números; sem desfecho diz que a
	// janela ainda está aberta (0/0 não é número, é ausência de dado).
	const secao = (
		nome: string,
		total: number,
		avaliadas: number,
		acertos: number,
		corpo: string,
	) => {
		if (total === 0) return;
		linhas.push(nome);
		if (avaliadas === 0) {
			linhas.push(
				`   ainda sem desfecho (${total} aposta(s) com janela aberta)`,
			);
		} else {
			linhas.push(corpo);
		}
	};
	const rt = resumo.porTipo.radar_chuva;
	secao(
		"Alerta de chuva (radar × pluviômetro):",
		rt?.total ?? 0,
		rt?.avaliadas ?? 0,
		rt?.acertos ?? 0,
		`   acertou (VP): ${rt?.acertos ?? 0} · errou (FP): ${(rt?.avaliadas ?? 0) - (rt?.acertos ?? 0)} · precisão: ${pct(rt?.precisaoPct ?? null)}\n   chuva sem alerta (FN): ${resumo.falsosNegativos}`,
	);
	const et = resumo.porTipo.eta_nucleo;
	secao(
		"ETA do núcleo:",
		et?.total ?? 0,
		et?.avaliadas ?? 0,
		et?.acertos ?? 0,
		`   acertou na tolerância: ${et?.acertos ?? 0}/${et?.avaliadas ?? 0} · erro médio: ±${num(resumo.erroMedioEtaMin)} min`,
	);
	const ec = resumo.porTipo.ecmwf_6h;
	secao(
		"Previsão ECMWF (6h):",
		ec?.total ?? 0,
		ec?.avaliadas ?? 0,
		ec?.acertos ?? 0,
		`   acertou o evento: ${ec?.acertos ?? 0}/${ec?.avaliadas ?? 0} · erro médio: ${num(resumo.erroMedioMmEcmwf)} mm`,
	);
	const cp = resumo.porTipo.copel_restabelecimento;
	secao(
		"Copel (restabelecimento no prazo):",
		cp?.total ?? 0,
		cp?.avaliadas ?? 0,
		cp?.acertos ?? 0,
		`   dentro do prazo: ${cp?.acertos ?? 0}/${cp?.avaliadas ?? 0} · atraso médio quando atrasou: ${num(resumo.atrasoMedioCopelMin)} min`,
	);
	if (resumo.avaliadas === 0) {
		linhas.push("");
		linhas.push(
			"_nota: ainda não há aposta avaliada — as apostas ficam pendentes até a janela de desfecho fechar. Os números amadurecem com os próximos eventos._",
		);
	} else if (resumo.avaliadas < 10) {
		linhas.push("");
		linhas.push(
			`_nota: só ${resumo.avaliadas} aposta(s) avaliada(s) — estatística ainda imatura; trate como sinal, não como veredito._`,
		);
	}
	return linhas.join("\n");
}
