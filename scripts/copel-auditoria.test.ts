import { Database } from "bun:sqlite";
import { expect, mock, test } from "bun:test";

const db = new Database(":memory:");
const executar = async (query: string | { sql: string; args: unknown[] }) => {
  const sql = typeof query === "string" ? query : query.sql;
  const args = typeof query === "string" ? [] : query.args;
  const stmt = db.query(sql);
  return { rows: /^\s*SELECT/i.test(sql) ? stmt.all(...args as []) : (stmt.run(...args as []), []) };
};
mock.module("../src/db.js", () => ({ getDbClient: async () => ({ execute: executar, batch: async (queries: Array<{ sql: string; args: unknown[] }>) => { for (const q of queries) await executar(q); } }) }));

test("registra abertura, atualização e fechamento apenas em consultas confirmadas", async () => {
  const { registrarSimulacaoCopel } = await import("../src/copel-simulacao.js");
  const base = { idOcorrencia: "1", numeroSequencial: "1", municipio: "IPIRANGA", bairro: "RURAL", ehProgramada: false, tipoPrincipal: "INTERRUPCAO", tipoEvento: "", dataInicio: "2026-11-18", previsaoRestabelecimento: null, faixaDuracao: "", statusEquipe: "", qtdConsumidores: 10, equipeId: "" };
  const dados = (timestamp: number, qtd: number, ok = true) => ({ timestamp, copelConsultaOk: ok, copelOutages: qtd ? [{ ...base, qtdConsumidores: qtd }] : [], newCopelOutages: timestamp === 1 ? [base] : [], saneparConsultaOk: true, saneparInterruptions: [], newSaneparInterruptions: [] });
  await registrarSimulacaoCopel(dados(1, 10), 6017, []);
  await registrarSimulacaoCopel(dados(2, 20), 6017, []);
  await registrarSimulacaoCopel(dados(3, 0, false), 6017, []);
  await registrarSimulacaoCopel(dados(4, 0), 6017, []);
  expect(db.query("SELECT tipo FROM copel_alteracoes_observadas ORDER BY id").all()).toEqual([{ tipo: "abertura" }, { tipo: "atualizacao" }, { tipo: "encerramento" }]);
  expect(db.query("SELECT ciclo FROM copel_simulacao ORDER BY ciclo").all()).toEqual([{ ciclo: 1 }, { ciclo: 2 }, { ciclo: 4 }]);
});
