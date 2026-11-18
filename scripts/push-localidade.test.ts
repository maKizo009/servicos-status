import { Database } from "bun:sqlite";
import { expect, mock, test } from "bun:test";
const db = new Database(":memory:");
db.run("CREATE TABLE push_subscriptions (endpoint TEXT PRIMARY KEY, p256dh TEXT, auth TEXT, created_at INTEGER, last_seen_at INTEGER)");
db.run("INSERT INTO push_subscriptions (endpoint, p256dh, auth) VALUES ('https://fcm.googleapis.com/a', 'public-key', 'secret-key')");
mock.module("../src/db.js", () => ({ getDbClient: async () => ({ execute: async (q: any) => { const sql = typeof q === 'string' ? q : q.sql; const args = typeof q === 'string' ? [] : q.args; const stmt = db.query(sql); return { rows: /^\s*SELECT/i.test(sql) ? stmt.all(...args) : (stmt.run(...args), []) }; } }) }));
test("preferência exige posse das chaves e normaliza localidade", async () => {
  const { salvarLocalidadePush } = await import("../src/push.js");
  const sub = { endpoint: "https://fcm.googleapis.com/a", keys: { p256dh: "public-key", auth: "secret-key" } };
  expect(await salvarLocalidadePush({ ...sub, keys: { ...sub.keys, auth: "outra" } }, "São Brás")).toBe(false);
  expect(await salvarLocalidadePush(sub, "São Brás")).toBe(true);
  expect(db.query("SELECT localidade FROM push_localidades").get()).toEqual({ localidade: "SAO BRAS" });
  expect(await salvarLocalidadePush(sub, "")).toBe(true);
  expect(db.query("SELECT count(*) AS total FROM push_localidades").get()).toEqual({ total: 0 });
});


test("o navegador pode registrar de novo a inscrição e salvar a localidade", async () => {
  const { handlePushRoutes } = await import("../src/router/push.js");
  const inscricao = { endpoint: "https://fcm.googleapis.com/b", keys: { p256dh: "public-key", auth: "secret-key" } };
  const preferencia = { ...inscricao, localidade: "Taboão" };
  const enviar = async (acao: string, payload: object) => {
    const url = new URL(`https://servicos-status.vercel.app/api/push/${acao}`);
    const req = new Request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    return handlePushRoutes({ req, url, path: url.pathname, method: "POST" });
  };

  const tentativa = await enviar("localidade", preferencia);
  expect(tentativa?.status).toBe(400);
  expect(await tentativa?.json()).toMatchObject({ code: "SUBSCRIPTION_NOT_FOUND" });
  expect((await enviar("subscribe", inscricao))?.ok).toBe(true);
  expect(await (await enviar("localidade", preferencia))?.json()).toEqual({ status: "ok" });
  expect(db.query("SELECT localidade FROM push_localidades WHERE endpoint = ?").get(inscricao.endpoint)).toEqual({ localidade: "TABOAO" });
  expect((await enviar("localidade", { ...preferencia, localidade: "" }))?.ok).toBe(true);
  expect(db.query("SELECT localidade FROM push_localidades WHERE endpoint = ?").get(inscricao.endpoint)).toBeNull();
});
