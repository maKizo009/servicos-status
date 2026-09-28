/**
 * Relatório do livro da dissipação.
 *
 * Lê as amostras que os ciclos gravaram (uma por núcleo relevante por ciclo),
 * agrupa em episódios e imprime a estatística que responde à hipótese do dono:
 * "é comum essas chuvas se dissipar conforme chegam aqui".
 *
 * Uso: bun run scripts/relatorio-dissipacao.ts [dias=14]
 * Requer as envs do Turso (TURSO_DATABASE_URL + token) — em produção elas existem;
 * localmente: `set -a; . ./.env; set +a`.
 *
 * Limitação declarada (não esconder no relatório): o radar de mosaico mede eco EM
 * ALTURA; "sumiu_antes_de_chegar" pode ser dissipação real, queda abaixo do limiar
 * de detecção ou saída do grid. E a chuva conta por PERÍODO do episódio, não por
 * atribuição célula↔estação (outro sistema pode chover junto).
 */
import { initDb, lerAmostrasDissipacao } from "../src/db.js";
import {
	agruparEpisodios,
	CHEGADA_KM,
	QUEDA_RELEVANTE_DBZ,
	resumoDissipacao,
} from "../src/dissipacao.js";

const dias = Number(process.argv[2] ?? 14);
const desde = Date.now() - dias * 24 * 3600_000;

await initDb(); // idempotente: cria a tabela se ainda não existir
const amostras = await lerAmostrasDissipacao(desde);
const nucleos = amostras.filter((a) => a.kind === "nucleo");
const eps = agruparEpisodios(nucleos);
const r = resumoDissipacao(eps);

const fmtHora = (ms: number) =>
	new Date(ms).toLocaleString("pt-BR", {
		day: "2-digit",
		month: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		timeZone: "America/Sao_Paulo",
	});

console.log(`\n📕 Livro da dissipação — últimos ${dias} dias`);
console.log(
	`   amostras: ${amostras.length} (núcleos: ${nucleos.length}) | episódios: ${r.episodios}\n`,
);

if (r.episodios === 0) {
	console.log(
		"   Ainda sem episódios suficientes. O livro começou a gravar agora —\n" +
			"   a estatística fica boa depois de alguns eventos de chuva.\n",
	);
	process.exit(0);
}

console.log("Desfecho dos episódios:");
const linha = (rotulo: string, n: number, extra = "") =>
	console.log(`   ${rotulo.padEnd(26)} ${String(n).padStart(3)}${extra}`);
linha("chegou e MOLHOU a estação", r.chegouEMolhou);
linha("chegou seco (eco em altura)", r.chegouSeco);
linha("dissipou no caminho", r.dissipouNoCaminho);
linha("sumiu antes de chegar", r.sumiuAntes);
console.log("");
console.log(`   chegaram em Ipiranga (≤${CHEGADA_KM} km): ${r.chegaram}`);
console.log(`   dos que chegaram, molharam o chão: ${r.pctChegouMolhando}%`);
console.log(
	`   perderam ≥${QUEDA_RELEVANTE_DBZ} dBZ no caminho: ${r.pctEnfraqueceu}%`,
);
console.log(`   ΔdBZ médio do episódio: ${r.deltaDbzMedio}`);
console.log(`   dBZ médio na chegada: ${r.dbzMedioNaChegada}`);
if (r.isoladosComDado > 0) {
	console.log(
		`   episódios de núcleo ISOLADO: ${r.isolados}/${r.isoladosComDado} (com dado)`,
	);
}

console.log("\nEpisódios (mais recentes primeiro):");
const recentes = [...eps].reverse().slice(0, 25);
for (const e of recentes) {
	const marcador =
		e.desfecho === "chegou_e_molhou"
			? "💧"
			: e.desfecho === "chegou_seco"
				? "🌫️"
				: e.desfecho === "dissipou_no_caminho"
					? "📉"
					: "❓";
	console.log(
		`   ${marcador} ${fmtHora(e.inicioEm)} | ${String(e.amostras).padStart(2)} ciclos ` +
			`(${e.duracaoMin} min) | ${e.dbzInicial}→${e.dbzFinal} dBZ (Δ${e.deltaDbz}) | ` +
			`chegou a ${e.distMinKm.toFixed(0)} km | chuva ${e.chuvaNoEpisodioMm} mm | ${e.desfecho}`,
	);
}

console.log(
	"\n⚠️  Leituras honestas: (a) \"sumiu antes de chegar\" NÃO distingue dissipação real,\n" +
		"    queda abaixo do limiar de detecção e saída do grid (o radar mede echo em altura);\n" +
		"    (b) a chuva é contada no PERÍODO do episódio, não atribuída célula→estação.\n",
);
