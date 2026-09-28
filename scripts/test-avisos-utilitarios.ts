/**
 * Avisos de energia/água no relatório unificado.
 *
 * Dois furos reais, relatados pelo dono em 28/09/2026 depois de receber push de
 * "queda de energia em 24 UCs" e não achar NADA no site:
 *
 *  1. FALHA SILENCIOSA: a sonda devolvia lista vazia tanto para "sem
 *     ocorrências" quanto para "não consegui consultar". O relatório afirmava
 *     "Sem ocorrências" com a API da Copel fora do ar.
 *  2. SEM MEMÓRIA: o card mostrava só o estado instantâneo. Quando a luz voltava,
 *     o aviso não existia em lugar nenhum da página (só numa aba escondida).
 *
 * Este teste trava as duas coisas: ignorância nunca vira "Sem ocorrências", e o
 * histórico de avisos entra no payload.
 */
import { describe, expect, test } from "bun:test";
import { type AllCheckData, buildUnifiedReport } from "../src/checker.js";

const base = (over: Partial<AllCheckData> = {}): AllCheckData => ({
	copelOutages: [],
	newCopelOutages: [],
	saneparInterruptions: [],
	newSaneparInterruptions: [],
	copelConsultaOk: true,
	saneparConsultaOk: true,
	timestamp: Date.UTC(2026, 8, 28, 11, 50),
	...over,
});

/** Ocorrência como a API da Copel entrega (campos crus, nomes em snake-ish). */
const ocorrencia = (over: Record<string, unknown> = {}) => ({
	idOcorrencia: "OC-1",
	numeroSequencial: "1",
	municipio: "IPIRANGA",
	bairro: "RURAL",
	ehProgramada: false,
	tipoPrincipal: "INTERRUPCAO",
	tipoEvento: "EMERGENCIAL",
	dataInicio: "2026-09-28 08:50:00",
	previsaoRestabelecimento: null,
	faixaDuracao: "ate_1h",
	statusEquipe: "PREPARACAO",
	qtdConsumidores: 24,
	equipeId: "EQ-1",
	...over,
});

describe("consulta não confirmada não vira 'Sem ocorrências'", () => {
	test("COPEL fora do ar: status warn, detalhe honesto e consultaFalhou", async () => {
		const rel = await buildUnifiedReport(base({ copelConsultaOk: false }));
		const copel = rel.services.find((s) => s.name === "Copel");
		expect(copel?.status).toBe("warn");
		expect(copel?.details).toContain("Não foi possível consultar a Copel");
		expect(copel?.details).not.toContain("Sem ocorrências");
		expect(copel?.data?.consultaFalhou).toBe(true);
		expect(Array.isArray(copel?.data?.recentEvents)).toBe(true);
	});

	test("Sanepar fora do ar: status warn e nunca 'Sem interrupções'", async () => {
		const rel = await buildUnifiedReport(base({ saneparConsultaOk: false }));
		const san = rel.services.find((s) => s.name === "Sanepar");
		expect(san?.status).toBe("warn");
		expect(san?.details).toContain("Não foi possível consultar a Sanepar");
		expect(san?.data?.consultaFalhou).toBe(true);
	});

	test("consulta confirmada e sem ocorrências: aí sim 'Sem ocorrências'", async () => {
		const rel = await buildUnifiedReport(base());
		const copel = rel.services.find((s) => s.name === "Copel");
		expect(copel?.status).toBe("ok");
		expect(copel?.details).toBe("Sem ocorrências");
		expect(copel?.data?.consultaFalhou).toBe(false);
	});
});

describe("o relatório continua contando o que importa", () => {
	test("INTERRUPCAO confirmada é crítica e soma as UCs", async () => {
		const rel = await buildUnifiedReport(
			base({
				copelOutages: [
					ocorrencia({ qtdConsumidores: 24 }),
					ocorrencia({
						idOcorrencia: "OC-2",
						bairro: "CENTRO",
						qtdConsumidores: 23,
					}),
				],
			}),
		);
		const copel = rel.services.find((s) => s.name === "Copel");
		expect(copel?.status).toBe("critical");
		expect(copel?.data?.totalConsumers).toBe(47);
		expect(copel?.data?.ocorrencias).toBe(2);
	});

	test("EMERGENCIA (não confirmada) não conta como interrupção", async () => {
		const rel = await buildUnifiedReport(
			base({
				copelOutages: [ocorrencia({ tipoPrincipal: "EMERGENCIA" })],
			}),
		);
		const copel = rel.services.find((s) => s.name === "Copel");
		expect(copel?.status).toBe("ok");
		expect(copel?.details).toContain("não confirmadas");
		expect(copel?.data?.totalConsumers).toBe(0);
	});

	test("sem banco (teste local) o relatório NÃO quebra — avisos ficam vazios", async () => {
		const rel = await buildUnifiedReport(base());
		// getRecentEvents falha sem credenciais do Turso; o try/catch devolve [] e
		// o relatório segue — a memória dos avisos nunca derruba o monitor.
		for (const s of rel.services) {
			expect(Array.isArray(s.data?.recentEvents)).toBe(true);
		}
	});
});
