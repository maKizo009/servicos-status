import { Database } from "bun:sqlite";
import { expect, mock, test } from "bun:test";
const db = new Database(":memory:");
db.run("CREATE TABLE push_subscriptions (endpoint TEXT PRIMARY KEY, p256dh TEXT, auth TEXT)");
db.run("INSERT INTO push_subscriptions VALUES ('https://fcm.googleapis.com/a', 'public-key', 'secret-key')");
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
