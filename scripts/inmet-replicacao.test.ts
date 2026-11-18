import { describe, expect, test } from "bun:test";
import { buildAlertaUnificado, descricaoParaPessoas, fetchAlertasOficiais, interpretarCapInmet, nivelSeveridadeInmet } from "../src/alertas-oficiais.js";

const cap = `<alert><msgType>Alert</msgType><info><severity>Extreme</severity>
<onset>2026-11-18T09:00:00-03:00</onset><expires>2026-11-18T23:59:00-03:00</expires>
<description>Chuva &amp; vento.</description><instruction>Evite árvores.</instruction>
<web>https://avisos.inmet.gov.br/1</web><parameter><valueName>Municipios</valueName>
<value>Ipiranga - PR (4110508)</value></parameter></info></alert>`;

describe("aviso oficial INMET", () => {
	test("reconhece Grande Perigo e campos do CAP", () => {
		expect(nivelSeveridadeInmet("Grande Perigo")).toBe("vermelho");
		const r = interpretarCapInmet(cap);
		expect(r.aviso.nivel).toBe("vermelho");
		expect(r.aviso.descricao).toBe("Chuva & vento.");
		expect(r.aviso.orientacoes).toBe("Evite árvores.");
		expect(r.aviso.cobreIpiranga).toBe(true);
	});
	test("distingue cancelamento e cobertura desconhecida", () => {
		expect(interpretarCapInmet(cap.replace("<msgType>Alert", "<msgType>Cancel")).cancelado).toBe(true);
		expect(interpretarCapInmet("<alert><msgType>Alert</msgType></alert>").aviso.cobreIpiranga).toBeUndefined();
	});
	test("não apresenta CAP cancelado pelo INMET", async () => {
		const anterior = globalThis.fetch;
		const rss = `<rss><item><title>Aviso de Tempestade. Severidade Grau: Grande Perigo</title><link>https://apiprevmet3.inmet.gov.br/avisos/rss/1</link><description><![CDATA[<p>Área Centro Oriental Paranaense</p>]]></description></item></rss>`;
		globalThis.fetch = (async (url) => {
			if (String(url).endsWith("/avisos/rss")) return new Response(rss.padEnd(220));
			if (String(url).endsWith("/avisos/rss/1")) return new Response(cap.replace("<msgType>Alert", "<msgType>Cancel"));
			return new Response("", { status: 503 });
		}) as typeof fetch;
		try {
			const dados = await fetchAlertasOficiais();
			expect(dados.avisos.filter(a => a.fonte === "INMET")).toHaveLength(0);
		} finally { globalThis.fetch = anterior; }
	});
	test("publica o texto e a cor oficiais, também no push", () => {
		const now = Date.now();
		const aviso = { fonte: "INMET" as const, titulo: "Aviso de Tempestade", nivel: "laranja" as const, descricao: "Texto oficial.", cobreIpiranga: true, inicio: new Date(now - 60000).toISOString(), fim: new Date(now + 60000).toISOString() };
		const resultado = buildAlertaUnificado({ acc1hrMax: 0, acc6hrMax: 0, acc24hrMax: 0, ecmwfPct: 0, ecmwfProx6hMm: 0, radarAlertLevel: "none", hidroWatch: false }, { avisos: [aviso], erros: [], atualizadoEm: now });
		expect(resultado.nivel).toBe("laranja");
		expect(resultado.descricao).toBe("Texto oficial.");
		expect(descricaoParaPessoas(resultado)).toBe("INMET: Texto oficial.");
		const intenso = buildAlertaUnificado({ acc1hrMax: 30, acc6hrMax: 0, acc24hrMax: 0, ecmwfPct: 0, ecmwfProx6hMm: 0, radarAlertLevel: "none", hidroWatch: false }, { avisos: [aviso], erros: [], atualizadoEm: now });
		expect(intenso.nivel).toBe("vermelho");
		expect(intenso.avisosOficiais[0]?.descricao).toBe("Texto oficial.");
	});
});
