/**
 * Valida a previsão de saída da calha do Bitumirim.
 *  1. Leave-one-out sobre os 11 rótulos (honesto: prevê cada um SEM ele mesmo).
 *  2. Estado AO VIVO: busca a chuva da SMA ABC (2056 + 1101) e roda a previsão.
 *
 * Uso: bun run scripts/test-previsao-bitumirim.ts [--live]
 */
import {
	ROTULOS_BITUMIRIM,
	buscarSerieABC,
	impressaoDigital,
	preverSaidaDaCalha,
	validarLeaveOneOut,
} from "../src/bitumirim-previsao.js";
import { regimeDoMes } from "../src/ana-hidro.js";
import type { RegimeHidro } from "../src/ana-hidro.js";

const live = process.argv.includes("--live");

console.log("=== 1. LEAVE-ONE-OUT (prevê cada rótulo sem ele mesmo) ===");
const loo = validarLeaveOneOut();
let acertos = 0;
let decididos = 0;
for (const r of loo) {
	const esp = r.esperado ? "transbordou" : "não saiu";
	const flag = r.acertou ? "✓" : r.veredito === "indefinido" ? "~" : "✗";
	if (r.veredito !== "indefinido") {
		decididos++;
		if (r.acertou) acertos++;
	}
	console.log(
		`  ${flag} ${r.id.padEnd(8)} esperado=${esp.padEnd(12)} veredito=${r.veredito.padEnd(11)} confianca=${String(r.confianca).padStart(3)}%`,
	);
}
console.log(
	`\n  acertos: ${acertos}/${decididos} decididos (${loo.length - decididos} indefinidos de ${loo.length})` +
		`\n  acertos contando indefinido como erro: ${acertos}/${loo.length}`,
);

// matriz de confusão
const tp = loo.filter((r) => r.esperado && r.veredito === "sim").length;
const fn = loo.filter((r) => r.esperado && r.veredito !== "sim").length;
const tn = loo.filter((r) => !r.esperado && r.veredito === "nao").length;
const fp = loo.filter((r) => !r.esperado && r.veredito !== "nao").length;
console.log(`  transbordos detectados: ${tp} (perdidos ${fn}) | não-saídas corretas: ${tn} (falso alarme ${fp})`);

if (live) {
	console.log("\n=== 2. ESTADO AO VIVO (SMA ABC) ===");
	const hoje = new Date().toISOString().slice(0, 10);
	console.log(`  buscando série diária de São Braz (2056) e Suruvi (1101) até ${hoje}...`);
	const [sb, su] = await Promise.all([buscarSerieABC("2056", hoje), buscarSerieABC("1101", hoje)]);
	console.log(`  São Braz: ${sb.length} dias | Suruvi: ${su.length} dias`);
	if (!sb.length || !su.length) {
		console.log("  ⚠️ série indisponível — previsão NÃO emitida (nunca inventar número)");
		process.exit(0);
	}
	const ult = sb.filter((p) => p.mm != null).slice(-5);
	console.log("  últimos dias São Braz:", ult.map((p) => `${p.data}=${p.mm?.toFixed(1)}`).join(" "));
	const ultSu = su.filter((p) => p.mm != null).slice(-5);
	console.log("  últimos dias Suruvi:  ", ultSu.map((p) => `${p.data}=${p.mm?.toFixed(1)}`).join(" "));

	const impr = impressaoDigital(sb, su, hoje);
	console.log("  impressão digital:", JSON.stringify(impr));
	const mes = Number(hoje.slice(5, 7));
	const regime: RegimeHidro = regimeDoMes(mes);
	const prev = preverSaidaDaCalha({ impr, regime, uvaiaCm: null, chuvaAgora: null });
	console.log(`\n  regime: ${regime}`);
	console.log(`  VAI SAIR DA CALHA? ${prev.vaiSair.toUpperCase()} — confiança ${prev.confianca}% (${prev.faixa})`);
	console.log(`  quando: ${prev.quandoHoras ? `~${prev.quandoHoras.provavel}h (faixa ${prev.quandoHoras.min}-${prev.quandoHoras.max}h)` : "sem janela em horas"}`);
	console.log(`  regra: ${prev.regra}`);
	for (const m of prev.motivos) console.log(`   · ${m}`);
	console.log(`  vizinhos: ${prev.vizinhos.total} (${prev.vizinhos.ids.join(", ") || "nenhum"})`);
}

console.log(`\nr[otulos carregados: ${ROTULOS_BITUMIRIM.length}`);
