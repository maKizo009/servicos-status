import { test, expect, mock } from "bun:test";
import { PNG } from "pngjs";

const entries = new Map<string, string>();
mock.module("../src/db.js", () => ({
  getDbClient: async () => ({
    execute: async (q: any) => {
      if (typeof q === "string") return { rows: [] };
      if (q.sql.startsWith("SELECT payload")) {
        const value = entries.get(q.args[0]);
        return { rows: value ? [{ payload: value }] : [] };
      }
      if (q.sql.startsWith("INSERT OR REPLACE")) entries.set(q.args[0], q.args[1]);
      return { rows: [] };
    },
  }),
}));

test("reutiliza frames completos e reprocessa frame com tile indisponível", async () => {
  const { analyzeRadarNowcast } = await import("../src/radar-analysis.js");
  const png = PNG.sync.write(new PNG({ width: 16, height: 16 }));
  const originalFetch = globalThis.fetch;
  let requests = 0;
  let fail = false;
  globalThis.fetch = (async () => {
    requests++;
    return fail ? new Response(null, { status: 503 }) : new Response(png);
  }) as typeof fetch;
  try {
    const frames = [1, 2, 3, 4].map((time) => ({ time, path: `/frame-${time}` }));
    const region = { z: 7, x: 46, y: 73 };
    const first = await analyzeRadarNowcast("https://radar.test", frames.slice(0, 3), region, 3, undefined, 16, false);
    expect(requests).toBe(3);
    const again = await analyzeRadarNowcast("https://radar.test", frames.slice(0, 3), region, 3, undefined, 16, false);
    expect(requests).toBe(3);
    expect(again.frames).toEqual(first.frames);
    fail = true;
    await analyzeRadarNowcast("https://radar.test", frames.slice(1), region, 3, undefined, 16, false);
    expect(requests).toBe(4);
    fail = false;
    await analyzeRadarNowcast("https://radar.test", frames.slice(1), region, 3, undefined, 16, false);
    expect(requests).toBe(5);
  } finally { globalThis.fetch = originalFetch; }
});
