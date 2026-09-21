/**
 * Testes do alerta unificado próprio (10/09/2026).
 *
 * Fusão determinística: dados locais (CEMADEN+ECMWF+radar+hidro) mandam;
 * avisos oficiais (INMET/Defesa Civil) AGRAVAM. Só o vermelho oficial
 * sobe sozinho — oficial amarelo/laranja sem chuva local vira amarelo
 * de atenção, nunca pânico.
 */
import { describe, expect, test } from "bun:test";
import {
	type AlertasOficiaisState,
	buildAlertaUnificado,
	type DadosLocaisAlerta,
} from "../src/alertas-oficiais.js";
import { pushParaAlerta } from "../src/push.js";

function local(over: Partial<DadosLocaisAlerta> = {}): DadosLocaisAlerta {
	return {
		acc1hrMax: 0,
		acc6hrMax: 0,
		acc24hrMax: 0,
		ecmwfPct: 10,
		ecmwfProx6hMm: 0,
		radarAlertLevel: "none",
		hidroWatch: false,
		...over,
	};
}

function oficiais(
	niveis: Array<"amarelo" | "laranja" | "vermelho"> = [],
): AlertasOficiaisState {
	return {
		avisos: niveis.map((n, i) => ({
			fonte: "INMET" as const,
			titulo: `Aviso teste ${i}`,
			nivel: n,
		})),
		erros: [],
		atualizadoEm: Date.now(),
	};
}

describe("Alerta unificado próprio", () => {
	test("tudo calmo → verde sem motivos", () => {
		const a = buildAlertaUnificado(local(), oficiais());
		expect(a.nivel).toBe("verde");
		expect(a.motivos.length).toBe(0);
	});

	test("chuva medida 41,6mm/24h + ECMWF 100% → ao menos amarelo", () => {
		const a = buildAlertaUnificado(
			local({ acc1hrMax: 3, acc6hrMax: 25, acc24hrMax: 41.6, ecmwfPct: 100 }),
			oficiais(),
		);
		expect(["amarelo", "laranja", "vermelho"]).toContain(a.nivel);
		expect(a.motivos.length).toBeGreaterThan(0);
	});

	test("radar alert de NÚCLEO severo (iminente) → laranja", () => {
		const a = buildAlertaUnificado(
			local({ radarAlertLevel: "alert", radarSevero: true, radarKind: "nucleo" }),
			oficiais(),
		);
		expect(a.nivel).toBe("laranja");
	});

	// ── Regra do dono (21/09/2026): severidade ≠ relevância. ─────────────────
	// Área de chuva moderada é relevante para o SITE e irrelevante para
	// INTERROMPER o celular. O caso real que gerou a regra: o dono recebeu push
	// laranja "chuva forte" enquanto a análise classificava a chuva que chegava
	// como MODERADA, porque `radarAlertLevel === "alert"` (puro, sem olhar o
	// tipo/intensidade da entidade) promovia qualquer entidade da zona de alerta.
	test("área de chuva moderada na zona de alerta → amarelo (não laranja)", () => {
		const a = buildAlertaUnificado(
			local({ radarAlertLevel: "alert", radarSevero: false, radarKind: "area" }),
			oficiais(),
		);
		expect(a.nivel).toBe("amarelo");
		expect(a.titulo).not.toContain("chuva forte");
		expect(a.titulo).toContain("se aproximando");
		expect(a.motivos.join(" ")).toContain("área de chuva");
	});

	test("área de chuva moderada NÃO gera push no celular", () => {
		const a = buildAlertaUnificado(
			local({ radarAlertLevel: "alert", radarSevero: false, radarKind: "area" }),
			oficiais(),
		);
		expect(pushParaAlerta(a.nivel)).toBeNull();
	});

	test("núcleo severo na zona de alerta GERA push (laranja)", () => {
		const a = buildAlertaUnificado(
			local({ radarAlertLevel: "alert", radarSevero: true, radarKind: "nucleo" }),
			oficiais(),
		);
		const regra = pushParaAlerta(a.nivel);
		expect(regra).not.toBeNull();
		expect(regra?.evento).toBe("alerta:laranja");
	});

	test("chuva MEDIDA acima do limiar gera push mesmo sem radar", () => {
		const a = buildAlertaUnificado(local({ acc6hrMax: 30 }), oficiais());
		expect(pushParaAlerta(a.nivel)).not.toBeNull();
	});

	test("chuva extrema medida (50mm/6h) → vermelho", () => {
		const a = buildAlertaUnificado(
			local({ acc6hrMax: 55, acc24hrMax: 60 }),
			oficiais(),
		);
		expect(a.nivel).toBe("vermelho");
	});

	test("oficial vermelho sozinho → vermelho (segurança)", () => {
		const a = buildAlertaUnificado(local(), oficiais(["vermelho"]));
		expect(a.nivel).toBe("vermelho");
	});

	test("oficial amarelo sozinho → amarelo de atenção, não pânico", () => {
		const a = buildAlertaUnificado(local(), oficiais(["amarelo"]));
		expect(a.nivel).toBe("amarelo");
	});

	test("oficial não rebaixa alerta local (laranja local + amarelo oficial)", () => {
		const a = buildAlertaUnificado(
			local({ radarAlertLevel: "alert", radarSevero: true, radarKind: "nucleo" }),
			oficiais(["amarelo"]),
		);
		expect(a.nivel).toBe("laranja");
	});

	test("hidro watch + chuva local → amarelo", () => {
		const a = buildAlertaUnificado(
			local({ acc24hrMax: 22, hidroWatch: true }),
			oficiais(),
		);
		expect(a.nivel).toBe("amarelo");
	});
});
