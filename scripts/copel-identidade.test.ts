import { afterEach, describe, expect, test } from "bun:test";
import { checkCopel } from "../src/probes/copel.js";
import { makeHash, type EventTracker } from "../src/state.js";

const fetchOriginal = globalThis.fetch;
afterEach(() => { globalThis.fetch = fetchOriginal; });

describe("identidade das ocorrências Copel", () => {
  test("migra um grupo já conhecido e não repete ao mudar consumidores", async () => {
    const registro = (consumidores: number) => ({ id_ocorrencia: "id-1", numero_sequencial: "seq-1", municipio: "IPIRANGA", bairro: "RURAL", data_inicio: "2026-11-18 08:00:00", tipo_principal: "INTERRUPCAO", qtd_consumidores: consumidores });
    let resposta = [registro(4), registro(8)];
    globalThis.fetch = (async () => new Response(JSON.stringify({ ocorrencias: resposta }))) as typeof fetch;
    const conjunto = new Set([`copel:${makeHash("id-1", "seq-1", "2026-11-18 08:00:00", "RURAL", "8")}`]);
    const tracker = { isKnown: (source: string, hash: string) => conjunto.has(`${source}:${hash}`), markKnown: async (source: string, hash: string) => { conjunto.add(`${source}:${hash}`); } } as EventTracker;
    expect((await checkCopel("https://example.test", "Ipiranga", 1000, tracker)).newOutages).toHaveLength(0);
    resposta = [registro(20)];
    expect((await checkCopel("https://example.test", "Ipiranga", 1000, tracker)).newOutages).toHaveLength(0);
    resposta = [{ ...registro(1), id_ocorrencia: "id-2" }, { ...registro(5), id_ocorrencia: "id-2" }];
    expect((await checkCopel("https://example.test", "Ipiranga", 1000, tracker)).newOutages).toHaveLength(1);
  });
});
