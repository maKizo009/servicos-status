import { describe, expect, test } from "bun:test";
import { planejarAvisoCopel } from "../src/copel-simulacao.js";

describe("simulação do alerta municipal Copel", () => {
	test("usa o total simultâneo, incluindo ocorrências pequenas", () => {
		expect(planejarAvisoCopel(19, 0, 3, 6017)).toEqual([]);
		expect(planejarAvisoCopel(21, 19, 0, 6017)).toContain("aviso municipal agrupado");
		expect(planejarAvisoCopel(21, 21, 0, 6017)).toEqual([]);
	});
	test("registra o agravamento ao atingir 10%", () => {
		expect(planejarAvisoCopel(602, 601, 0, 6017)).toContain("agravamento para 10% da rede");
		expect(planejarAvisoCopel(601, 600, 0, 6017)).not.toContain("agravamento para 10% da rede");
	});
});
