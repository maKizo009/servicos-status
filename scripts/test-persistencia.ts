/**
 * Persistência da evidência severa entre ciclos (29/09/2026).
 *
 * Caso real que motivou a mudança: no ciclo 15:40/15:46 de 29/09/2026 o monitor
 * disparou LARANJA (nível que interrompe o celular) com um único motivo — um
 * núcleo HEAVY de 38 dBZ (piso da faixa "forte"), ISOLADO, a 64 km, que já vinha
 * ENFRAQUECENDO (43 → 38 dBZ no ciclo anterior). Um ciclo depois ele virou área
 * moderada e o nível caiu sozinho para amarelo. Medição independente dos tiles
 * (15:00 → 15:50): picos ≥43 dBZ zerados e massa de eco do núcleo caindo
 * (680 → 551 px), com ZERO eco num raio de 15 km de Ipiranga.
 *
 * Duas barreiras complementares são testadas aqui:
 *  1. PISO/tendência no ciclo (`avaliarNucleoSevero`) — não promover núcleo da
 *     metade fraca da faixa "forte" que está enfraquecendo;
 *  2. PERSISTÊNCIA entre ciclos (`avaliarPersistencia`) — interromper o celular
 *     exige evidência sustentada em ≥2 ciclos seguidos de radar (10 min cada).
 *
 * Os valores de distância/intensidade abaixo são os do payload de produção do
 * incidente, não números inventados.
 */
import { describe, expect, test } from "bun:test";
import { buildAlertaUnificado, type DadosLocaisAlerta } from "../src/alertas-oficiais.js";
import {
	type CicloEvidenciaSevera,
	avaliarPersistencia,
	CICLOS_PARA_CONFIRMAR,
	contarCiclosConsecutivos,
	EMERGENCIA_KM,
	JANELA_CICLO_MIN,
} from "../src/persistencia-alerta.js";
import { pushParaAlerta } from "../src/push.js";
import {
	avaliarNucleoSevero,
	NUCLEO_EMERGENCIA_KM,
	PISO_FORTE_CONFIRMADO_DBZ,
	type ThreatCell,
} from "../src/radar-analysis.js";

const T0 = 1_790_706_000_000; // frame de radar de 29/09/2026 15:40 BRT
const min = (n: number) => n * 60_000;

function celula(over: Partial<ThreatCell> = {}): ThreatCell {
	return {
		id: "c1",
		intensity: "heavy",
		pixelCount: 3515,
		maxDbz: 38,
		meanDbz: 28,
		centroidX: 974,
		centroidY: 712,
		lat: -25.5267,
		lon: -50.8944,
		kind: "nucleo",
		framesVivo: 3,
		vizinhosFortes: 0,
		isolado: true,
		tendencia: "enfraquecendo",
		movement: {
			directionDeg: 349,
			speedKmh: 51.2,
			intervalMin: 10,
			dxPx: -3,
			dyPx: -15,
			fromLat: -25.6022,
			fromLon: -50.8793,
			toLat: -25.5267,
			toLon: -50.8944,
			dbzAnterior: 43,
			deltaDbz: -5,
			tendencia: "enfraquecendo",
		},
		threat: {
			bearingFromTargetDeg: 209.07,
			radialKmh: -39.17,
			radialFraction: -0.765,
			approach: "approaching",
			etaMin: 97.9,
		},
		distToTargetKm: 63.95,
		relevanceZone: "alert",
		...over,
	};
}

function ciclo(over: Partial<CicloEvidenciaSevera> = {}): CicloEvidenciaSevera {
	return {
		ts: T0 - min(10),
		nucleoSevero: true,
		imediato: false,
		maxDbz: 43,
		distKm: 72,
		tendencia: "estavel",
		kind: "nucleo",
		nivel: "laranja",
		...over,
	};
}

function local(over: Partial<DadosLocaisAlerta> = {}): DadosLocaisAlerta {
	return {
		acc1hrMax: 0,
		acc6hrMax: 0,
		acc24hrMax: 0,
		// Sem chuva medida aqui: o caso real tinha pluviômetro zerado — quem
		// dirigia o alerta era SÓ o radar.
		ecmwfPct: 20,
		ecmwfProx6hMm: 0,
		radarAlertLevel: "alert",
		radarKind: "nucleo",
		hidroWatch: false,
		...over,
	};
}

describe("piso de severidade do núcleo iminente (o ciclo)", () => {
	test("REAL 29/09/2026: heavy 38 dBZ enfraquecendo a 64 km NÃO promove", () => {
		const v = avaliarNucleoSevero([celula()]);
		expect(v).not.toBeNull();
		expect(v?.severo).toBe(false);
		expect(v?.imediato).toBe(false);
		expect(v?.motivo).toBe("piso_enfraquecendo");
	});

	test("heavy 38 dBZ ESTÁVEL promove (não é só o piso que barra)", () => {
		const v = avaliarNucleoSevero([celula({ tendencia: "estavel" })]);
		expect(v?.severo).toBe(true);
		expect(v?.motivo).toBe("tendencia_ok");
	});

	test("heavy 38 dBZ INTENSIFICANDO promove (pulso convectivo crescendo)", () => {
		const v = avaliarNucleoSevero([celula({ tendencia: "intensificando" })]);
		expect(v?.severo).toBe(true);
		expect(v?.motivo).toBe("tendencia_ok");
	});

	test("heavy 43 dBZ enfraquecendo AINDA promove (metade forte da faixa)", () => {
		const v = avaliarNucleoSevero([
			celula({ intensity: "heavy", maxDbz: PISO_FORTE_CONFIRMADO_DBZ, tendencia: "enfraquecendo" }),
		]);
		expect(v?.severo).toBe(true);
		expect(v?.motivo).toBe("intensidade_confirmada");
	});

	test("heavy 38 dBZ SEM tendência medida não promove (sem evidência positiva)", () => {
		const v = avaliarNucleoSevero([celula({ tendencia: null, movement: null })]);
		expect(v?.severo).toBe(false);
		expect(v?.motivo).toBe("piso_sem_tendencia");
	});

	test("extreme a 70 km promove mas NÃO é emergência (espera confirmação)", () => {
		const v = avaliarNucleoSevero([
			celula({ intensity: "extreme", maxDbz: 58, distToTargetKm: 70, tendencia: "enfraquecendo" }),
		]);
		expect(v?.severo).toBe(true);
		expect(v?.imediato).toBe(false);
		expect(v?.motivo).toBe("extreme");
	});

	test("extreme a 40 km é EMERGÊNCIA: promove na hora, sem esperar ciclo", () => {
		const v = avaliarNucleoSevero([
			celula({ intensity: "extreme", maxDbz: 58, distToTargetKm: 40 }),
		]);
		expect(v?.severo).toBe(true);
		expect(v?.imediato).toBe(true);
		expect(v?.motivo).toBe("emergencia_proxima");
	});

	test("núcleo maduro mas fora da zona iminente (watch) não gera veredito", () => {
		// Zona watch = ≤200 km: relevante para o card, NÃO para o push.
		expect(
			avaliarNucleoSevero([
				celula({ distToTargetKm: 150, relevanceZone: "watch" }),
			]),
		).toBeNull();
	});
});

describe("persistência entre ciclos", () => {
	test("1º ciclo da evidência: aguarda confirmação (não interrompe celular)", () => {
		const p = avaliarPersistencia({
			historico: [],
			agoraMs: T0,
			nucleoSeveroAgora: true,
		});
		expect(p.persistiu).toBe(false);
		expect(p.motivo).toBe("aguardando_confirmacao");
		expect(p.ciclosConsecutivos).toBe(1);
	});

	test("2º ciclo consecutivo confirma (é o que libera laranja/push)", () => {
		const p = avaliarPersistencia({
			historico: [ciclo({ ts: T0 - min(10) })],
			agoraMs: T0,
			nucleoSeveroAgora: true,
		});
		expect(p.persistiu).toBe(true);
		expect(p.motivo).toBe("confirmado");
		expect(p.ciclosConsecutivos).toBe(2);
	});

	test("ciclos consecutivos acumulam (3º ciclo → 3)", () => {
		const p = avaliarPersistencia({
			historico: [
				ciclo({ ts: T0 - min(20) }),
				ciclo({ ts: T0 - min(10) }),
			],
			agoraMs: T0,
			nucleoSeveroAgora: true,
		});
		expect(p.ciclosConsecutivos).toBe(3);
	});

	test("BURACO maior que a janela reinicia a contagem (ciclo perdido)", () => {
		const p = avaliarPersistencia({
			historico: [ciclo({ ts: T0 - min(JANELA_CICLO_MIN + 25) })],
			agoraMs: T0,
			nucleoSeveroAgora: true,
		});
		expect(p.persistiu).toBe(false);
		expect(p.ciclosConsecutivos).toBe(1);
	});

	test("ciclo sem evidência no meio quebra a sequência (não é contagem total)", () => {
		const p = avaliarPersistencia({
			historico: [
				ciclo({ ts: T0 - min(20) }),
				ciclo({ ts: T0 - min(10), nucleoSevero: false }),
			],
			agoraMs: T0,
			nucleoSeveroAgora: true,
		});
		expect(p.persistiu).toBe(false);
		expect(p.ciclosConsecutivos).toBe(1);
	});

	test("a linha do PRÓPRIO ciclo não conta duas vezes (cron roda 2x no frame)", () => {
		const p = avaliarPersistencia({
			historico: [ciclo({ ts: T0 })],
			agoraMs: T0,
			nucleoSeveroAgora: true,
		});
		expect(p.ciclosConsecutivos).toBe(1);
		expect(p.persistiu).toBe(false);
	});

	test("sem núcleo severo agora → não há o que confirmar", () => {
		const p = avaliarPersistencia({
			historico: [ciclo({ ts: T0 - min(10) })],
			agoraMs: T0,
			nucleoSeveroAgora: false,
		});
		expect(p.persistiu).toBe(false);
		expect(p.motivo).toBe("sem_nucleo_severo");
		expect(p.ciclosConsecutivos).toBe(0);
	});

	test("EMERGÊNCIA local (extreme ≤ 50 km) não espera confirmação", () => {
		const p = avaliarPersistencia({
			historico: [],
			agoraMs: T0,
			nucleoSeveroAgora: true,
			imediatoAgora: true,
		});
		expect(p.persistiu).toBe(true);
		expect(p.motivo).toBe("emergencia_imediata");
	});

	test("FALHA de leitura do histórico é fail-open (com motivo), nunca silêncio", () => {
		const p = avaliarPersistencia({
			historico: null,
			agoraMs: T0,
			nucleoSeveroAgora: true,
		});
		expect(p.persistiu).toBe(true);
		expect(p.motivo).toBe("historico_indisponivel");
	});

	test("contarCiclosConsecutivos ignora linhas futuras", () => {
		expect(
			contarCiclosConsecutivos(
				[ciclo({ ts: T0 + min(10) }), ciclo({ ts: T0 - min(10) })],
				T0,
			),
		).toBe(1);
	});

	test("constantes alinhadas: emergência do radar = emergência da persistência", () => {
		expect(NUCLEO_EMERGENCIA_KM).toBe(EMERGENCIA_KM);
		expect(CICLOS_PARA_CONFIRMAR).toBe(2);
	});
});

describe("nível do alerta com a persistência (ponta a ponta determinística)", () => {
	test("núcleo severo no 1º ciclo → AMARELO com motivo do 1º ciclo (sem push)", () => {
		const a = buildAlertaUnificado(
			local({ radarSevero: false, radarSeveroNaoConfirmado: true }),
			null,
		);
		expect(a.nivel).toBe("amarelo");
		// Copy atual (revisão do dono): o motivo diz que vamos confirmar antes
		// de alertar — o teste antigo esperava "1º ciclo" (termo interno antigo).
		expect(a.motivos.join(" ")).toContain("vamos confirmar nos próximos minutos");
		// O ponto da mudança: o celular NÃO é interrompido.
		expect(pushParaAlerta(a.nivel)).toBeNull();
	});

	test("núcleo severo CONFIRMADO em 2 ciclos → LARANJA e push sai", () => {
		const a = buildAlertaUnificado(
			local({ radarSevero: true, radarSeveroCiclos: 2 }),
			null,
		);
		expect(a.nivel).toBe("laranja");
		// Copy atual: "confirmada no radar há 2 checagens seguidas".
		expect(a.motivos.join(" ")).toContain("confirmada no radar há 2 checagens");
		expect(pushParaAlerta(a.nivel)?.evento).toBe("alerta:laranja");
	});

	test("o fluxo real de 29/09/2026 (38 dBZ enfraquecendo, 1º ciclo) não vira laranja", () => {
		// Junta as duas barreiras como o ciclo de produção faz: piso/tendência
		// decide `severoAgora`; a persistência decide se pode interromper.
		const v = avaliarNucleoSevero([celula()]);
		const severoAgora = v?.severo === true;
		const p = avaliarPersistencia({
			historico: [],
			agoraMs: T0,
			nucleoSeveroAgora: severoAgora,
			imediatoAgora: v?.imediato === true,
		});
		const a = buildAlertaUnificado(
			local({
				radarSevero: severoAgora && p.persistiu,
				radarSeveroNaoConfirmado: severoAgora && !p.persistiu,
				radarSeveroCiclos: p.ciclosConsecutivos,
			}),
			null,
		);
		expect(a.nivel).not.toBe("laranja");
		expect(a.nivel).not.toBe("vermelho");
		expect(pushParaAlerta(a.nivel)).toBeNull();
	});
});
