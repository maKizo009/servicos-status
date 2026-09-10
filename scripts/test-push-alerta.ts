/**
 * Testes da regra de push do alerta unificado (10/09/2026):
 * só laranja/vermelho cutucam o celular; verde/amarelo ficam no site.
 */
import { describe, expect, test } from "bun:test";
import { pushParaAlerta } from "../src/push.js";

describe("pushParaAlerta", () => {
	test("verde e amarelo → silêncio (sem spam)", () => {
		expect(pushParaAlerta("verde")).toBeNull();
		expect(pushParaAlerta("amarelo")).toBeNull();
	});
	test("laranja → evento próprio, cooldown 90min", () => {
		const r = pushParaAlerta("laranja");
		expect(r).not.toBeNull();
		expect(r!.evento).toBe("alerta:laranja");
		expect(r!.ttlMs).toBe(90 * 60_000);
		expect(r!.emoji.length).toBeGreaterThan(0);
	});
	test("vermelho → evento próprio, cooldown 30min (mais urgente)", () => {
		const r = pushParaAlerta("vermelho");
		expect(r).not.toBeNull();
		expect(r!.evento).toBe("alerta:vermelho");
		expect(r!.ttlMs).toBe(30 * 60_000);
	});
	test("eventos distintos por nível (cooldown independente)", () => {
		expect(pushParaAlerta("laranja")!.evento).not.toBe(
			pushParaAlerta("vermelho")!.evento,
		);
	});
});
