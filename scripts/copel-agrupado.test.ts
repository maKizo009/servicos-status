import { Database } from "bun:sqlite";
import { expect, mock, test } from "bun:test";
const db = new Database(":memory:");
const executar = async (q: any) => { const sql = typeof q === "string" ? q : q.sql; const args = typeof q === "string" ? [] : q.args; const stmt = db.query(sql); return { rows: /^\s*SELECT/i.test(sql) ? stmt.all(...args) : (stmt.run(...args), []) }; };
mock.module("../src/db.js", () => ({ getDbClient: async () => ({ execute: executar, batch: async (queries: any[]) => { for (const q of queries) await executar(q); } }) }));
const tentativas = new Map<string, number>();
let falhaConsulta = false;
mock.module("../src/push.js", () => ({ pushConfigured: () => true, listPushSubscriptions: async () => { if (falhaConsulta) throw new Error("fonte indisponível"); return [{ endpoint: "a" }, { endpoint: "b" }]; }, sendPushAlert: async (_t: string, _c: string, _u: string, _l: string, endpoint: string) => { const n = (tentativas.get(endpoint) ?? 0) + 1; tentativas.set(endpoint, n); return { ok: endpoint === "b" && n === 1 ? 0 : 1, falhas: endpoint === "b" && n === 1 ? 1 : 0 }; } }));
let telegram = 0;
mock.module("../src/telegram.js", () => ({ sendTelegramAlert: async () => ++telegram > 1 }));
test("retenta somente destinos que falharam", async () => {
  const { processarAvisosCopelAgrupados } = await import("../src/copel-agrupado.js");
  const o = { idOcorrencia: "1", numeroSequencial: "1", municipio: "IPIRANGA", bairro: "RURAL", ehProgramada: false, tipoPrincipal: "INTERRUPCAO", tipoEvento: "", dataInicio: "2026-11-18", previsaoRestabelecimento: null, faixaDuracao: "", statusEquipe: "", qtdConsumidores: 30, equipeId: "" };
  const d = { timestamp: Date.now(), copelConsultaOk: true, copelOutages: [o], newCopelOutages: [o], saneparConsultaOk: true, saneparInterruptions: [], newSaneparInterruptions: [] };
  await processarAvisosCopelAgrupados(d, ["aviso municipal agrupado"], "t", "c");
  await processarAvisosCopelAgrupados(d, ["aviso municipal agrupado"], "t", "c");
  expect(tentativas.get("a")).toBe(1);
  expect(tentativas.get("b")).toBe(2);
  expect(telegram).toBe(2);
  expect(db.query("SELECT COUNT(*) n FROM copel_fila_agrupada WHERE pendente=1").get()).toEqual({ n: 0 });
  expect(db.query("SELECT tentativas FROM copel_fila_agrupada WHERE endpoint='b'").get()).toEqual({ tentativas: 2 });
});

test("falha antes de enfileirar é identificada para permitir o envio alternativo", async () => {
  const { processarAvisosCopelAgrupados, ErroEnfileiramentoCopel } = await import("../src/copel-agrupado.js");
  const o = { idOcorrencia: "3", numeroSequencial: "3", municipio: "IPIRANGA", bairro: "RURAL", ehProgramada: false, tipoPrincipal: "INTERRUPCAO", tipoEvento: "", dataInicio: "2026-11-18", previsaoRestabelecimento: null, faixaDuracao: "", statusEquipe: "", qtdConsumidores: 30, equipeId: "" };
  falhaConsulta = true;
  try {
    await expect(processarAvisosCopelAgrupados({ timestamp: Date.now(), copelConsultaOk: true, copelOutages: [o], newCopelOutages: [o], saneparConsultaOk: true, saneparInterruptions: [], newSaneparInterruptions: [] }, ["aviso municipal agrupado"], "t", "c")).rejects.toBeInstanceOf(ErroEnfileiramentoCopel);
  } finally { falhaConsulta = false; }
});

test("cancela envio pendente quando a ocorrência encerra", async () => {
  const { processarAvisosCopelAgrupados } = await import("../src/copel-agrupado.js");
  const o = { idOcorrencia: "2", numeroSequencial: "2", municipio: "IPIRANGA", bairro: "CENTRO", ehProgramada: false, tipoPrincipal: "INTERRUPCAO", tipoEvento: "", dataInicio: "2026-11-18", previsaoRestabelecimento: null, faixaDuracao: "", statusEquipe: "", qtdConsumidores: 30, equipeId: "" };
  const d = { timestamp: Date.now(), copelConsultaOk: true, copelOutages: [o], newCopelOutages: [o], saneparConsultaOk: true, saneparInterruptions: [], newSaneparInterruptions: [] };
  tentativas.set("b", 0);
  await processarAvisosCopelAgrupados(d, ["aviso municipal agrupado"], "t", "c");
  await processarAvisosCopelAgrupados({ ...d, timestamp: d.timestamp + 600000, copelOutages: [], newCopelOutages: [] }, [], "t", "c");
  expect(db.query("SELECT estado FROM copel_fila_agrupada WHERE endpoint='b' ORDER BY rowid DESC LIMIT 1").get()).toEqual({ estado: "desatualizado" });
});
