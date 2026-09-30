/**
 * Testes da reconciliação de previsões (Plano 2, 30/09/2026) — funções puras.
 *
 * O que está em jogo: o boletim de acurácia vai calibrar limiar de alerta com
 * número (falso positivo/negativo, erro de ETA). Se a contagem estiver errada,
 * a calibração mente — por isso cada regra de desfecho tem teste travado.
 *
 * Rode com: bun test ./scripts/test-reconciliacao.ts
 */
import { describe, expect, test } from "bun:test";
import { dataBrasiliaParaMs } from "../src/previsoes.js";
import {
	type Avaliacao,
	agregarAcuracia,
	avaliarCopelRestabelecimento,
	avaliarEcmwf6h,
	avaliarEtaNucleo,
	avaliarRadarChuva,
	chuvaNaJanela,
	eventosDeChuva,
	falsosNegativos,
	formatarRelatorioAcuracia,
	type MedicaoChuva,
	type Previsao,
} from "../src/reconciliacao.js";

const H = 3600_000;
const T0 = 1_790_000_000_000;

const med = (ts: number, mm1h: number | null, stale = false): MedicaoChuva => ({
	ts,
	estacao: "G2-TESTE",
	mm1h,
	stale,
});

const prev = (
	tipo: Previsao["tipo"],
	registradoEm: number,
	janelaFim: number,
	alvo: Record<string, unknown>,
	id = 1,
): Previsao => ({
	id,
	tipo,
	chave: `${tipo}:${id}`,
	registradoEm,
	janelaFim,
	alvo,
	desfecho: null,
	avaliadoEm: null,
	acertou: null,
});

describe("chuvaNaJanela / eventosDeChuva", () => {
	test("soma só o que está na janela e não está stale", () => {
		const medidas = [
			med(T0 - H, 5), // antes da janela
			med(T0 + H, 1.2),
			med(T0 + 2 * H, 0.8),
			med(T0 + 3 * H, 3, true), // stale: não conta
			med(T0 + 4 * H, 0), // dentro, mas zero
		];
		expect(chuvaNaJanela(medidas, T0, T0 + 6 * H)).toBe(2);
	});

	test("eventos agrupam medições seguidas (gap ≤ 2h) e separam blocos", () => {
		const medidas = [
			med(T0, 1),
			med(T0 + H, 2),
			med(T0 + 2 * H, 0.5), // ainda o mesmo evento
			med(T0 + 10 * H, 1), // bloco novo (gap > 2h)
		];
		const evs = eventosDeChuva(medidas);
		expect(evs.length).toBe(2);
		expect(evs[0]?.mmTotal).toBe(3.5);
	});

	test("falso negativo = evento de chuva que nenhuma aposta cobriu", () => {
		const medidas = [med(T0, 1), med(T0 + H, 1)];
		const coberta = prev("radar_chuva", T0 - H, T0 + 6 * H, {}, 1);
		const deOutroDia = prev("radar_chuva", T0 + 100 * H, T0 + 106 * H, {}, 2);
		expect(falsosNegativos(medidas, [coberta, deOutroDia]).length).toBe(0);
		expect(falsosNegativos(medidas, [deOutroDia]).length).toBe(1);
	});
});

describe("avaliarRadarChuva", () => {
	test("VP quando o pluviômetro mede ≥0,2 mm na janela", () => {
		const p = prev("radar_chuva", T0, T0 + 2 * H, {});
		const a = avaliarRadarChuva(p, [med(T0 + H, 0.5)]);
		expect(a.acertou).toBe(true);
		expect(a.desfecho.mmMedidos).toBe(0.5);
	});

	test("FP quando não mediu nada (radar alertou e a chuva não veio)", () => {
		const p = prev("radar_chuva", T0, T0 + 2 * H, {});
		const a = avaliarRadarChuva(p, [med(T0 + H, 0), med(T0 + 3 * H, 5)]);
		expect(a.acertou).toBe(false); // 5mm vieram DEPOIS da janela
	});
});

describe("avaliarEtaNucleo", () => {
	test("erro dentro da tolerância = acertou", () => {
		const p = prev("eta_nucleo", T0, T0 + 4 * H, { etaMin: 40 });
		// começou a chover 50 min depois → erro +10 min (tolerância ±30)
		const a = avaliarEtaNucleo(p, [med(T0 + 50 * 60_000, 1)]);
		expect(a.acertou).toBe(true);
		expect(a.desfecho.erroMin).toBe(10);
	});

	test("erro fora da tolerância = errou", () => {
		const p = prev("eta_nucleo", T0, T0 + 8 * H, { etaMin: 30 });
		// chuva só 3h depois (erro +150 min; tolerância ±30)
		const a = avaliarEtaNucleo(p, [med(T0 + 3 * H, 1)]);
		expect(a.acertou).toBe(false);
		expect(a.desfecho.chegou).toBe(true);
	});

	test("não choveu na janela = não chegou (falso alarme, não erro de ETA)", () => {
		const p = prev("eta_nucleo", T0, T0 + 2 * H, { etaMin: 30 });
		const a = avaliarEtaNucleo(p, [med(T0 + H, 0)]);
		expect(a.acertou).toBe(false);
		expect(a.desfecho.chegou).toBe(false);
	});
});

describe("avaliarEcmwf6h", () => {
	test("acerta o evento mas erra o mm", () => {
		const p = prev("ecmwf_6h", T0, T0 + 6 * H, {
			mmPrevistos: 10,
			probPct: 80,
		});
		const a = avaliarEcmwf6h(p, [med(T0 + H, 1.5)]);
		expect(a.acertou).toBe(true); // previu chuva, choveu
		expect(a.desfecho.erroMm).toBe(-8.5);
	});

	test("previu chuva e não choveu = errou o evento", () => {
		const p = prev("ecmwf_6h", T0, T0 + 6 * H, { mmPrevistos: 4, probPct: 70 });
		const a = avaliarEcmwf6h(p, [med(T0 + H, 0)]);
		expect(a.acertou).toBe(false);
		expect(a.desfecho.eventoMedido).toBe(false);
	});
});

describe("avaliarCopelRestabelecimento", () => {
	const p = prev("copel_restabelecimento", T0, T0 + 6 * H, {
		prazoMs: 2 * H,
		idOcorrencia: "1-26B47938",
	});

	test("voltou dentro do prazo = acertou", () => {
		const a = avaliarCopelRestabelecimento(p, T0 + H, T0 + 3 * H);
		expect(a?.acertou).toBe(true);
		expect(a?.desfecho.atrasoMin).toBe(0);
	});

	test("voltou depois do prazo = errou (com o atraso em minutos)", () => {
		const a = avaliarCopelRestabelecimento(p, T0 + 4 * H, T0 + 5 * H);
		expect(a?.acertou).toBe(false);
		expect(a?.desfecho.atrasoMin).toBe(120);
	});

	test("ainda ativa dentro do prazo = pendente (não avalia)", () => {
		expect(avaliarCopelRestabelecimento(p, null, T0 + H)).toBeNull();
	});

	test("ainda ativa MUITO depois do prazo = errou", () => {
		const a = avaliarCopelRestabelecimento(p, null, T0 + 10 * H);
		expect(a?.acertou).toBe(false);
		expect(a?.desfecho.aindaAtiva).toBe(true);
	});
});

describe("agregação e relatório", () => {
	test("precisão, FP e FN batem com as avaliações de entrada", () => {
		const previsoes = [
			prev("radar_chuva", T0, T0 + H, {}, 1),
			prev("radar_chuva", T0, T0 + H, {}, 2),
			prev("eta_nucleo", T0, T0 + H, { etaMin: 30 }, 3),
		];
		const avaliacoes: Avaliacao[] = [
			{ id: 1, tipo: "radar_chuva", acertou: true, desfecho: {} },
			{ id: 2, tipo: "radar_chuva", acertou: false, desfecho: {} },
			{
				id: 3,
				tipo: "eta_nucleo",
				acertou: true,
				desfecho: { chegou: true, erroMin: 10 },
			},
		];
		const r = agregarAcuracia(previsoes, avaliacoes, [
			{ inicio: T0, mmTotal: 2 },
		]);
		expect(r.avaliadas).toBe(3);
		expect(r.acertos).toBe(2);
		expect(r.precisaoPct).toBe(67);
		expect(r.falsosPositivos).toBe(1);
		expect(r.falsosNegativos).toBe(1);
		expect(r.erroMedioEtaMin).toBe(10);
		const texto = formatarRelatorioAcuracia(r, 7);
		expect(texto).toContain("Boletim de acurácia");
		expect(texto).toContain("67%");
		expect(texto).toContain("chuva sem alerta (FN): 1");
	});

	test("sem apostas avaliadas o relatório avisa que a estatística é imatura", () => {
		const r = agregarAcuracia([], [], []);
		const texto = formatarRelatorioAcuracia(r, 7);
		expect(texto).toContain("ainda não há aposta avaliada");
	});
});

describe("datas da Copel (horário de Brasília)", () => {
	test("'2026-09-30 13:00:00' vira epoch em -03:00 (servidor roda em UTC)", () => {
		const ms = dataBrasiliaParaMs("2026-09-30 13:00:00");
		expect(ms).toBe(Date.parse("2026-09-30T13:00:00-03:00"));
	});

	test("string ilegível vira null (nunca NaN)", () => {
		expect(dataBrasiliaParaMs("sem previsão")).toBeNull();
	});
});
