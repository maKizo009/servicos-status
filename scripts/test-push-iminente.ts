/**
 * Push de chuva iminente: rótulo e corpo têm que falar da MESMA entidade.
 *
 * Notificação recebida pelo dono em 27/09/2026:
 *   título: "⛈️ Alerta de tempestade em Ipiranga"
 *   corpo:  "🌧️ Área de chuva moderada detectada a ~39 km de Ipiranga,
 *            aproximando-se (chegada em ~57 min)..."
 * O push disparava com qualquer `alertLevel === "alert"` (que inclui ÁREA de chuva
 * moderada entrando na zona iminente) e o corpo vinha do texto do radar da área.
 */
import { describe, expect, test } from "bun:test";
import {
	avisoMovimentoNucleo,
	conteudoPushChuvaIminente,
	pushParaAlerta,
} from "../src/push.js";

describe("push de chuva iminente fala da entidade certa", () => {
	test("núcleo de tempestade: título de tempestade + aviso de olhar o radar", () => {
		const c = conteudoPushChuvaIminente({
			radarSevero: true,
			textoRadar:
				"⛈️ Núcleo de chuva muito forte (temporal) detectado a ~67 km de Ipiranga, aproximando-se (chegada em ~94 min).",
		});
		expect(c?.titulo).toBe("⛈️ Alerta de tempestade em Ipiranga");
		expect(c?.corpo).toContain("Núcleo de chuva muito forte");
		expect(c?.corpo).toContain(
			"acompanhe a movimentação do núcleo no radar do app",
		);
		expect(c?.corpo).toContain("condições podem mudar");
	});

	test("ÁREA de chuva moderada NÃO interrompe o celular (sem push)", () => {
		// O caso do relato: entidade = área, nenhum núcleo severo → null.
		expect(
			conteudoPushChuvaIminente({
				radarSevero: false,
				textoRadar: "🌧️ Área de chuva moderada detectada a ~39 km de Ipiranga.",
			}),
		).toBe(null);
	});

	test("sem texto do radar, o corpo não fica vazio nem com espaço duplo", () => {
		const c = conteudoPushChuvaIminente({ radarSevero: true, textoRadar: "  " });
		expect(c?.corpo.startsWith("Núcleo de chuva forte se aproximando")).toBe(true);
		expect(c?.corpo).not.toContain("  ");
	});

	test("o aviso do radar só existe quando há núcleo severo", () => {
		expect(avisoMovimentoNucleo(true)).toContain("movimentação do núcleo");
		expect(avisoMovimentoNucleo(false)).toBe(null);
	});

	test("doutrina do dono: amarelo não cutuca o celular", () => {
		expect(pushParaAlerta("verde")).toBe(null);
		expect(pushParaAlerta("amarelo")).toBe(null);
		expect(pushParaAlerta("laranja")?.evento).toBe("alerta:laranja");
		expect(pushParaAlerta("laranja")?.ttlMs).toBe(90 * 60_000);
		expect(pushParaAlerta("vermelho")?.evento).toBe("alerta:vermelho");
		expect(pushParaAlerta("vermelho")?.ttlMs).toBe(30 * 60_000);
	});
});
