/**
 * Testes do heartbeat por fonte (meta-monitoria Plano 1, 30/09/2026).
 *
 * Regras sob teste (src/source-health.ts):
 * - fallback de dados INVENTADOS (Open-Meteo, boletim heurístico, radar em
 *   cache) nunca conta como fonte "ok" — dado fabricado não é dado medido;
 * - consulta não confirmada (Copel/Sanepar) é fonte fora, não "sem ocorrências";
 * - /health nunca pode dizer "healthy" com fonte cega, nem "degraded" sem
 *   evidência (o antigo respondia degraded em todo cold start).
 *
 * Rode com: bun test scripts/test-source-health.ts
 */
import { describe, expect, test } from "bun:test";
import {
	avaliarSaudeMonitor,
	derivarFontes,
	type FonteStatus,
} from "../src/source-health.js";
import type { WeatherState } from "../src/types.js";

const AGORA = 1_790_000_000_000; // epoch fixo — determinismo

function estadoBase(): WeatherState {
	return {
		municipio: "Ipiranga",
		tempC: 22,
		condition: "Encoberto",
		rainProbabilityPct: 40,
		windKmh: 10,
		humidityPct: 70,
		hasRegionalRain: false,
		regionalRainAlert: "Sem instabilidades ativas no radar regional.",
		hourlyForecast: [
			{ time: "12:00", tempC: 23, rainProbabilityPct: 40, precipitationMm: 0 },
		],
		fonteOpenMeteo: { ok: true, erro: null },
		radar: {
			host: "https://tilecache.rainviewer.com",
			version: "2.0",
			generated: Math.floor(AGORA / 1000),
			radar: { past: [], nowcast: [] },
			satellite: { infrared: [] },
			status: "ok",
			lastSuccessTime: AGORA - 60_000,
		},
		bulletin: null,
		nowcastBulletin: {
			text: "Sem chuva relevante para Ipiranga.",
			source: "gemini",
			generatedAt: AGORA - 5 * 60_000,
		},
		cemaden: {
			estacoes: [],
			fonte: "Cemaden",
			atualizadoEm: AGORA - 60_000,
			erro: null,
		},
		hidro: {
			estacoes: [],
			fonte: "ANA Hidro (telemetria)",
			atualizadoEm: AGORA - 60_000,
			erro: null,
			riscoEnxurrada: "ok",
			riscoCheia: "ok",
			ifl: null,
		} as unknown as WeatherState["hidro"],
		alertasOficiais: {
			avisos: [],
			erros: [],
			atualizadoEm: AGORA - 60_000,
		},
		updatedAt: AGORA,
	};
}

const porNome = (
	fontes: FonteStatus[],
	nome: string,
): FonteStatus | undefined => fontes.find((f) => f.nome === nome);

describe("derivarFontes", () => {
	test("estado saudável → todas as fontes ok", () => {
		const fontes = derivarFontes(estadoBase(), undefined, AGORA);
		expect(fontes.length).toBe(6); // sem copel/sanepar (checks ausentes)
		expect(fontes.every((f) => f.ok)).toBe(true);
	});

	test("radar em fallback de cache (degraded) NÃO é ok", () => {
		const e = estadoBase();
		const radar = e.radar;
		if (!radar) throw new Error("fixture sem radar");
		radar.status = "degraded";
		radar.error = "Fallback ativado (timeout)";
		const f = porNome(derivarFontes(e, undefined, AGORA), "radar_rainviewer");
		expect(f?.ok).toBe(false);
		expect(f?.detalhe).toContain("cache");
	});

	test("Open-Meteo em fallback de defaults = dado inventado = fonte fora", () => {
		const e = estadoBase();
		e.fonteOpenMeteo = { ok: false, erro: "HTTP 503" };
		const f = porNome(derivarFontes(e, undefined, AGORA), "open_meteo");
		expect(f?.ok).toBe(false);
		expect(f?.detalhe).toContain("PADRÃO");
		// Falha não reivindica sucesso: o histórico real fica no SQL (preservado).
		expect(f?.ultimoSucesso).toBeNull();
	});

	test("boletim heurístico = fallback do VLM, não ok", () => {
		const e = estadoBase();
		e.nowcastBulletin = {
			text: "x",
			source: "heuristic",
			generatedAt: AGORA - 60_000,
		};
		const f = porNome(derivarFontes(e, undefined, AGORA), "boletim_vlm");
		expect(f?.ok).toBe(false);
		expect(f?.ultimoErro).toContain("heurístico");
	});

	test("boletim VLM velho (>45 min) = fonte estagnada", () => {
		const e = estadoBase();
		e.nowcastBulletin = {
			text: "x",
			source: "gemini",
			generatedAt: AGORA - 70 * 60_000,
		};
		const f = porNome(derivarFontes(e, undefined, AGORA), "boletim_vlm");
		expect(f?.ok).toBe(false);
		expect(f?.ultimoErro).toContain("70 min");
	});

	test("CEMADEN com erro e hidro desatualizado aparecem como falha", () => {
		const e = estadoBase();
		const cemaden = e.cemaden;
		if (!cemaden) throw new Error("fixture sem cemaden");
		cemaden.erro = "getJson2 timeout";
		const hidro = e.hidro as unknown as { desatualizado?: boolean };
		hidro.desatualizado = true;
		const fontes = derivarFontes(e, undefined, AGORA);
		expect(porNome(fontes, "cemaden")?.ok).toBe(false);
		expect(porNome(fontes, "ana_hidro")?.ok).toBe(false);
		expect(porNome(fontes, "ana_hidro")?.ultimoErro).toContain(
			"última triangulação",
		);
	});

	test("avisos oficiais com erros = fonte degradada (agravante cego)", () => {
		const e = estadoBase();
		e.alertasOficiais = {
			avisos: [],
			erros: ["INMET alertas2 indisponível (timeout/bloqueio)"],
			atualizadoEm: AGORA - 60_000,
		};
		const f = porNome(derivarFontes(e, undefined, AGORA), "alertas_oficiais");
		expect(f?.ok).toBe(false);
		expect(f?.ultimoErro).toContain("INMET");
	});

	test("consulta não confirmada (copel/sanepar) = fonte fora, nunca 'ok'", () => {
		const fontes = derivarFontes(
			estadoBase(),
			{ copelConsultaOk: false, saneparConsultaOk: true },
			AGORA,
		);
		expect(porNome(fontes, "copel")?.ok).toBe(false);
		expect(porNome(fontes, "copel")?.ultimoErro).toContain("não confirmada");
		expect(porNome(fontes, "sanepar")?.ok).toBe(true);
	});

	test("estado null (instância fria sem ciclo de clima) → só serviços", () => {
		const fontes = derivarFontes(
			null,
			{ copelConsultaOk: true, saneparConsultaOk: true },
			AGORA,
		);
		expect(fontes.map((f) => f.nome).sort()).toEqual(["copel", "sanepar"]);
	});
});

describe("avaliarSaudeMonitor", () => {
	const fonteOk = (nome: string): FonteStatus => ({
		nome,
		rotulo: nome,
		ok: true,
		ultimaTentativa: AGORA - 60_000,
		ultimoSucesso: AGORA - 60_000,
		ultimoErro: null,
		falhasConsecutivas: 0,
		detalhe: null,
	});

	test("sem histórico → unknown (e NÃO degraded — o bug do cold start)", () => {
		const s = avaliarSaudeMonitor([], AGORA);
		expect(s.status).toBe("unknown");
		expect(s.dataAgeSec).toBeNull();
	});

	test("tudo ok e ciclo fresco → healthy", () => {
		const s = avaliarSaudeMonitor(
			[fonteOk("radar_rainviewer"), fonteOk("open_meteo")],
			AGORA,
		);
		expect(s.status).toBe("healthy");
		expect(s.problemas).toEqual([]);
	});

	test("UMA fonte cega derruba para degraded e nomeia o problema", () => {
		const quebrada = {
			...fonteOk("open_meteo"),
			ok: false,
			ultimoSucesso: AGORA - 40 * 60_000,
			ultimoErro: "HTTP 503",
			falhasConsecutivas: 4,
		};
		const s = avaliarSaudeMonitor(
			[fonteOk("radar_rainviewer"), quebrada],
			AGORA,
		);
		expect(s.status).toBe("degraded");
		expect(s.problemas.join(" ")).toContain("open_meteo");
		expect(s.problemas.join(" ")).toContain("40 min");
		expect(s.problemas.join(" ")).toContain("4 falhas seguidas");
	});

	test("ciclo parado (>25 min sem heartbeat) = degraded, mesmo com fontes ok", () => {
		const s = avaliarSaudeMonitor(
			[fonteOk("radar_rainviewer")],
			AGORA + 30 * 60_000,
		);
		expect(s.status).toBe("degraded");
		expect(s.problemas.join(" ")).toContain("ciclo parado");
		expect(s.dataAgeSec).toBeGreaterThan(25 * 60);
	});
});
