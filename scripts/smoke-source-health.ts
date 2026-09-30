/**
 * Smoke do heartbeat por fonte contra o banco REAL (source_health).
 *
 * Valida o caminho de escrita/leitura que o /health e o vigia externo usam:
 * upsert, incremento de falhas_consecutivas no SQL, reset no sucesso e
 * preservação de ultimo_sucesso durante falhas. Grava só a linha `_selftest`
 * e apaga no fim — nada de resíduo.
 *
 * Rode com: bun run scripts/smoke-source-health.ts  (requer TURSO_* no .env)
 */
import { getDbClient, initDb } from "../src/db.js";
import {
	derivarFontes,
	type FonteStatus,
	lerSourceHealth,
	salvarSourceHealth,
} from "../src/source-health.js";

const NOME = "_selftest";

function linha(ok: boolean, agora: number): FonteStatus {
	return {
		nome: NOME,
		rotulo: "Smoke source-health",
		ok,
		ultimaTentativa: agora,
		ultimoSucesso: ok ? agora : null,
		ultimoErro: ok ? null : "falha simulada",
		falhasConsecutivas: 0,
		detalhe: "smoke",
	};
}

async function main(): Promise<void> {
	await initDb();
	const db = await getDbClient();
	await db.execute({
		sql: "DELETE FROM source_health WHERE nome = ?",
		args: [NOME],
	});

	const t0 = Date.now();
	await salvarSourceHealth(linha(true, t0));
	await salvarSourceHealth(linha(false, t0 + 1000));
	await salvarSourceHealth(linha(false, t0 + 2000));
	await salvarSourceHealth(linha(true, t0 + 3000));

	const rows = (await lerSourceHealth()).filter((f) => f.nome === NOME);
	if (rows.length !== 1) {
		console.error(`FALHA: esperava 1 linha de ${NOME}, veio ${rows.length}`);
		process.exit(1);
	}
	const r = rows[0];
	if (!r) {
		console.error("FALHA: linha de _selftest sumiu da leitura");
		process.exit(1);
	}
	console.log("linha final:", JSON.stringify(r, null, 2));

	const problemas: string[] = [];
	if (!r.ok) problemas.push("último ciclo ok não reverteu ok=1");
	if (r.falhasConsecutivas !== 0)
		problemas.push(
			`falhas_consecutivas deveria zerar no sucesso (=${r.falhasConsecutivas})`,
		);
	if (r.ultimoErro !== null)
		problemas.push("ultimoErro deveria limpar no sucesso");
	if (r.ultimoSucesso !== t0 + 3000)
		problemas.push(`ultimoSucesso errado: ${r.ultimoSucesso} ≠ ${t0 + 3000}`);

	// Derivação pura: 1 sanity check sem banco
	const fontes = derivarFontes(null, { copelConsultaOk: false }, t0);
	const copel = fontes.find((f) => f.nome === "copel");
	if (copel?.ok !== false)
		problemas.push("derivarFontes: consulta não ok virou ok");

	await db.execute({
		sql: "DELETE FROM source_health WHERE nome = ?",
		args: [NOME],
	});

	if (problemas.length > 0) {
		console.error("SMOKE FALHOU:\n- " + problemas.join("\n- "));
		process.exit(1);
	}
	console.log(
		"SMOKE OK — upsert/incremento/reset/leitura do source_health funcionando.",
	);
	process.exit(0);
}

main().catch((e) => {
	console.error("SMOKE FALHOU (exceção):", String(e));
	process.exit(1);
});
