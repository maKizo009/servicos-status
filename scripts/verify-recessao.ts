/**
 * Verificação HONESTA da recessão (padrão do projeto: rodar o código novo sobre
 * o payload do momento reclamado e comparar com o que a produção reportou).
 *
 *   bun run scripts/verify-recessao.ts                  # busca AO VIVO na ANA
 *   bun run scripts/verify-recessao.ts --payload f.json # replay de payload salvo
 *
 * No replay, o `hidro.estacoes` do payload é reconstruído como `fetchEstacao`
 * faria (recessão + faixa efetiva calculadas da série) — sem rede, determinístico.
 */
import {
	avaliarRecessao,
	avaliarRisco,
	faixaComRecessao,
	faixaEstendida,
	fetchHidroTriangulacao,
	type ChuvaLocal,
	type HidroEstacao,
	type HidroState,
} from "../src/ana-hidro.js";

const args = process.argv.slice(2);
const iPayload = args.indexOf("--payload");
const caminho = iPayload >= 0 ? args[iPayload + 1] : null;

const m = (cm: number | null | undefined) =>
	cm == null ? "—" : `${(cm / 100).toFixed(2).replace(".", ",")} m`;

function relatar(hidro: HidroState, chuva: ChuvaLocal | null) {
	console.log(`\nFonte: ${hidro.fonte} · atualizado ${hidro.atualizadoEm ? new Date(hidro.atualizadoEm).toLocaleString("pt-BR") : "—"}`);
	for (const e of hidro.estacoes ?? []) {
		const r = e.recessao;
		console.log(
			`\n• ${e.nome.split(" (")[0]} (${e.codigo}) — ${m(e.nivelCm)} · Δ6h ${e.delta6hCm ?? "—"} cm` +
				`\n  faixa medida: ${e.faixa ?? "—"} · faixa EFETIVA (com recessão): ${e.faixaEfetiva ?? e.faixa ?? "—"}` +
				`\n  dispara alerta de Ipiranga: ${e.disparaAlerta === false ? "NÃO (jusante)" : "sim"}` +
				(r
					? `\n  recessão: ${r.confirmada ? "CONFIRMADA" : "não"} · ${r.horasSemSubir} h sem subir · ${r.quedaDesdePicoCm} cm abaixo do pico (${m(r.picoCm)} → ${m(r.atualCm)})`
					: ""),
		);
	}
	const risco = avaliarRisco(
		(hidro.estacoes ?? []).map((e) => ({
			...e,
			faixa: e.faixa,
			faixaEfetiva: e.faixaEfetiva ?? faixaComRecessao(e.faixa ?? faixaEstendida(e.codigo, e.nivelCm), e.recessao),
			recessao: e.recessao,
		})),
		chuva,
	);
	console.log(`\nriscoCheia: ${risco.riscoCheia} · riscoEnxurrada: ${risco.riscoEnxurrada}`);
	console.log(`resumo: ${risco.resumoRisco}`);
	const removido = risco.riscoCheia === "ok" && (hidro.estacoes ?? []).some((e) => e.recessao?.confirmada && e.faixa === "alerta");
	console.log(
		`\nVEREDITO: ${risco.riscoCheia === "watch" ? "alerta MANTIDO" : removido ? "alerta REMOVIDO pela recessão (nível segue em atenção)" : "sem alerta"}`,
	);
}

if (caminho) {
	const bruto = JSON.parse(await Bun.file(caminho).text());
	const h = (bruto.hidro ?? bruto) as HidroState;
	const estacoes = (h.estacoes ?? []).map((e) => {
		const recessao = avaliarRecessao(e.serie ?? []);
		return {
			...e,
			recessao,
			faixaEfetiva: faixaComRecessao(e.faixa ?? faixaEstendida(e.codigo, e.nivelCm), recessao),
		};
	});
	console.log(`REPLAY do payload ${caminho} (sem rede) — o que a produção reportou: riscoCheia=${h.riscoCheia}`);
	relatar({ ...h, estacoes }, null);
} else {
	console.log("Busca AO VIVO na telemetria ANA (3 sentinelas)…");
	relatar(await fetchHidroTriangulacao(null), null);
}
