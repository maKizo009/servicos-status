/**
 * Maleabilidade do tom do alerta (pedido do dono 27/09/2026):
 * "o sistema precisa ter a maleabilidade de mudar o tom do alerta se necessário"
 * — o núcleo estava perdendo força e o alerta tem que saber descer, e dizer que
 * desceu, em vez de ficar com tom de tempestade.
 */
import { describe, expect, test } from "bun:test";
import {
	type DadosLocaisAlerta,
	buildAlertaUnificado,
} from "../src/alertas-oficiais.js";

/** Sem chuva medida, sem avisos oficiais: só o radar fala. */
function local(over: Partial<DadosLocaisAlerta> = {}): DadosLocaisAlerta {
	return {
		acc1hrMax: null,
		acc6hrMax: null,
		acc24hrMax: null,
		pluviometroSemDado: false,
		ecmwfPct: null,
		ecmwfProx6hMm: null,
		radarAlertLevel: "monitor",
		radarSevero: false,
		radarKind: null,
		hidroWatch: false,
		...over,
	};
}

describe("o nível não gruda: desce quando o núcleo enfraquece", () => {
	test("núcleo severo iminente = laranja; no ciclo seguinte, sem ele = amarelo/verde", () => {
		const comNucleo = buildAlertaUnificado(
			local({ radarAlertLevel: "alert", radarSevero: true, radarKind: "nucleo" }),
			null,
			{ nivelAnterior: "amarelo" },
		);
		expect(comNucleo.nivel).toBe("laranja");

		// Mesmo núcleo agora só em vigilância (enfraqueceu → saiu da zona iminente)
		const enfraqueceu = buildAlertaUnificado(
			local({ radarAlertLevel: "watch", radarSevero: false, radarKind: "area" }),
			null,
			{ nivelAnterior: comNucleo.nivel },
		);
		expect(enfraqueceu.nivel).toBe("amarelo");
		expect(enfraqueceu.descricao).toContain("Alerta rebaixado de laranja para amarelo");
	});

	test("rebaixamento narra a dissipação quando o núcleo está enfraquecendo", () => {
		const u = buildAlertaUnificado(
			local({ radarAlertLevel: "watch", radarSevero: false }),
			null,
			{ nivelAnterior: "laranja", nucleoDissipando: true },
		);
		expect(u.nivel).toBe("amarelo");
		expect(u.descricao).toContain("o núcleo está enfraquecendo no radar");
	});

	test("subida do alerta também é dita (simétrico)", () => {
		const u = buildAlertaUnificado(
			local({ radarAlertLevel: "alert", radarSevero: true, radarKind: "nucleo" }),
			null,
			{ nivelAnterior: "amarelo" },
		);
		expect(u.descricao).toContain("Alerta subiu de amarelo para laranja");
	});

	test("sem mudança de nível, nenhuma frase de transição", () => {
		const u = buildAlertaUnificado(local(), null, { nivelAnterior: "verde" });
		expect(u.descricao).not.toContain("rebaixado");
		expect(u.descricao).not.toContain("subiu");
	});

	test("tudo zerado: nível verde (nada de tom preso)", () => {
		expect(buildAlertaUnificado(local(), null).nivel).toBe("verde");
	});
});
