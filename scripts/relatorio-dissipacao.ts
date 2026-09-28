/**
 * Relatório do livro da dissipação (rodar na máquina que TEM as credenciais do
 * Turso). Localmente as envs TURSO_* estão redigidas — o caminho normal é o
 * endpoint de produção:
 *
 *   GET https://servicos-status.vercel.app/api/dissipacao?dias=14
 *   Authorization: Bearer $CRON_SECRET
 *
 * Aqui: `bun run scripts/relatorio-dissipacao.ts [dias=14]` com as envs carregadas.
 */
import { initDb, lerAmostrasDissipacao } from "../src/db.js";
import { agruparEpisodios, formatarRelatorioTexto } from "../src/dissipacao.js";

const dias = Number(process.argv[2] ?? 14);

await initDb(); // idempotente
const amostras = await lerAmostrasDissipacao(Date.now() - dias * 24 * 3600_000);
const nucleos = amostras.filter((a) => a.kind === "nucleo");

console.log(formatarRelatorioTexto(agruparEpisodios(nucleos), dias));
console.log(`   (amostras lidas: ${amostras.length} | núcleos: ${nucleos.length})`);
