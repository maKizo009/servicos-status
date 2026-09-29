/**
 * O SQL da persistência de ciclos roda de verdade? (29/09/2026)
 *
 * O banco de produção é Turso (libsql remoto) e as credenciais NÃO existem nesta
 * máquina (redigidas de propósito), então o ciclo real não pode ser exercitado
 * daqui. Este teste fecha a lacuna que sobra: extrai o SQL **do próprio db.ts**
 * (nada de copiar e desviar) e executa contra um SQLite em memória, checando o
 * que mais dói se estiver errado:
 *
 *  - o UPSERT por `ciclo_ts` ATUALIZA a linha do ciclo em vez de duplicar
 *    (o cron roda mais de uma vez por frame de radar — duplicar inflaria a
 *    contagem de ciclos consecutivos e o alerta dispararia sem base);
 *  - a leitura sai em ordem cronológica (o avaliador depende da ordem);
 *  - `lerUltimoNivelAlerta` pega o nível do ciclo mais recente (memória do nível
 *    entre ciclos, que o cache em memória da Vercel não garante);
 *  - a retenção apaga pelo `avaliado_em`.
 */
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

const DB_TS = new URL("../src/db.ts", import.meta.url).pathname;
const fonte = await Bun.file(DB_TS).text();

function extrair(re: RegExp, nome: string): string {
	const m = fonte.match(re);
	if (!m) throw new Error(`SQL não encontrado no db.ts: ${nome}`);
	return m[0];
}

const createTable = extrair(
	/`CREATE TABLE IF NOT EXISTS radar_alerta_ciclos \([\s\S]*?\)`,/,
	"CREATE TABLE radar_alerta_ciclos",
).replace(/^`|`,$/g, "");
const createIndex = extrair(
	/`CREATE INDEX IF NOT EXISTS idx_radar_alerta_ciclos_avaliado[\s\S]*?\)`,/,
	"índice de radar_alerta_ciclos",
).replace(/^`|`,$/g, "");
const insertSql = extrair(
	/sql: `INSERT INTO radar_alerta_ciclos[\s\S]*?motivo = excluded\.motivo`,/,
	"INSERT/UPSERT de radar_alerta_ciclos",
)
	.replace(/^sql: `/, "")
	.replace(/`,$/, "");

const T0 = 1_790_706_000_000;

function db() {
	const d = new Database(":memory:");
	d.run(createTable);
	d.run(createIndex);
	return d;
}

function gravar(
	d: Database,
	ts: number,
	valores: {
		nucleoSevero: number;
		imediato?: number;
		severoConfirmado?: number;
		ciclos?: number | null;
		maxDbz?: number | null;
		distKm?: number | null;
		tendencia?: string | null;
		kind?: string | null;
		lat?: number | null;
		lon?: number | null;
		nivel?: string | null;
		motivo?: string | null;
		avaliadoEm?: number;
	},
) {
	const stmt = d.query(insertSql);
	stmt.run(
		ts,
		valores.avaliadoEm ?? Date.now(),
		valores.nucleoSevero,
		valores.imediato ?? 0,
		valores.severoConfirmado ?? 0,
		valores.ciclos ?? null,
		valores.maxDbz ?? null,
		valores.distKm ?? null,
		valores.tendencia ?? null,
		valores.kind ?? null,
		valores.lat ?? null,
		valores.lon ?? null,
		valores.nivel ?? null,
		valores.motivo ?? null,
	);
}

describe("SQL da persistência de ciclos (extraído do db.ts)", () => {
	test("o INSERT tem 14 placeholders (bate com os 14 args do código)", () => {
		expect((insertSql.match(/\?/g) ?? []).length).toBe(14);
	});

	test("UPSERT por ciclo_ts: rodar 2x no MESMO frame não duplica", () => {
		const d = db();
		gravar(d, T0, { nucleoSevero: 1, severoConfirmado: 0, ciclos: 1, maxDbz: 38 });
		gravar(d, T0, {
			nucleoSevero: 1,
			severoConfirmado: 1,
			ciclos: 2,
			maxDbz: 43,
			nivel: "laranja",
		});
		const linhas = d.query("SELECT * FROM radar_alerta_ciclos").all() as Array<
			Record<string, unknown>
		>;
		expect(linhas.length).toBe(1);
		expect(linhas[0]?.ciclos_consecutivos).toBe(2);
		expect(linhas[0]?.max_dbz).toBe(43);
		expect(linhas[0]?.nivel).toBe("laranja");
	});

	test("ciclos diferentes coexistem e a leitura sai em ordem CRESCENTE", () => {
		const d = db();
		gravar(d, T0 + 600_000, { nucleoSevero: 1 });
		gravar(d, T0, { nucleoSevero: 1 });
		gravar(d, T0 - 600_000, { nucleoSevero: 0 });
		const rows = d.query(
			"SELECT ciclo_ts FROM radar_alerta_ciclos WHERE ciclo_ts >= ? ORDER BY ciclo_ts ASC LIMIT ?",
		).all(T0 - 600_000, 500) as Array<{ ciclo_ts: number }>;
		expect(rows.map((r) => r.ciclo_ts)).toEqual([
			T0 - 600_000,
			T0,
			T0 + 600_000,
		]);
	});

	test("lerUltimoNivelAlerta devolve o nível do ciclo mais recente", () => {
		const d = db();
		gravar(d, T0, { nucleoSevero: 1, nivel: "amarelo" });
		gravar(d, T0 + 600_000, { nucleoSevero: 1, nivel: "laranja" });
		gravar(d, T0 + 1_200_000, { nucleoSevero: 0, nivel: null });
		const r = d.query(
			"SELECT nivel FROM radar_alerta_ciclos WHERE nivel IS NOT NULL ORDER BY ciclo_ts DESC LIMIT 1",
		).all() as Array<{ nivel: string | null }>;
		expect(r[0]?.nivel).toBe("laranja");
	});

	test("retenção apaga pelo avaliado_em (não pelo ciclo_ts)", () => {
		const d = db();
		const velho = Date.now() - 40 * 24 * 3600_000;
		gravar(d, T0, { nucleoSevero: 1, avaliadoEm: velho });
		gravar(d, T0 + 600_000, { nucleoSevero: 1 });
		d.run("DELETE FROM radar_alerta_ciclos WHERE avaliado_em < ?", [
			Date.now() - 30 * 24 * 3600_000,
		]);
		const um = d.query("SELECT COUNT(*) AS n FROM radar_alerta_ciclos").get() as {
			n: number;
		};
		expect(um.n).toBe(1);
	});

	test("ciclo_ts é chave primária (o UPSERT depende disso)", () => {
		const d = db();
		const info = d
			.query(
				"SELECT name, pk FROM pragma_table_info('radar_alerta_ciclos') WHERE pk > 0",
			)
			.all() as Array<{ name: string; pk: number }>;
		expect(info.map((i) => i.name)).toEqual(["ciclo_ts"]);
	});
});
