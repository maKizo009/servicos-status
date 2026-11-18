import { getDbClient } from "./db.js";
import { logger } from "./logger.js";
import type { AllCheckData } from "./checker.js";

export function planejarAvisoCopel(consumidores: number, anterior: number, novosConsumidores: number, totalCidade: number): string[] {
  const motivos: string[] = [];
  if (consumidores >= 20 && (anterior < 20 || novosConsumidores >= 20)) motivos.push("aviso municipal agrupado");
  if (totalCidade > 0 && consumidores >= Math.ceil(totalCidade * 0.1) && anterior < Math.ceil(totalCidade * 0.1)) motivos.push("agravamento para 10% da rede");
  return motivos;
}

/** Consulta a situação anterior antes de gravar o ciclo atual. */
export async function prepararPropostaCopel(data: AllCheckData, totalCidade: number): Promise<{ data: AllCheckData; motivos: string[] }> {
  const db = await getDbClient();
  const anterior = await db.execute("SELECT consumidores FROM copel_simulacao ORDER BY ciclo DESC LIMIT 1");
  const conhecidos = await db.execute("SELECT id FROM copel_ocorrencias_observadas WHERE encerrado_em IS NULL");
  const idsConhecidos = new Set(conhecidos.rows.map(r => String(r.id)));
  const confirmadas = data.copelOutages.filter(o => (o.tipoPrincipal || "").toUpperCase().includes("INTERRUPCAO"));
  const novas = confirmadas.filter(o => !idsConhecidos.has(o.idOcorrencia || o.numeroSequencial || `${o.bairro}|${o.dataInicio}`));
  const consumidores = confirmadas.reduce((n, o) => n + (Number(o.qtdConsumidores) || 0), 0);
  const novosConsumidores = novas.reduce((n, o) => n + (Number(o.qtdConsumidores) || 0), 0);
  const motivos = planejarAvisoCopel(consumidores, Number(anterior.rows[0]?.consumidores ?? 0), novosConsumidores, totalCidade);
  return { data: { ...data, newCopelOutages: novas }, motivos };
}

/** A proposta é registrada em paralelo aos envios atuais para avaliação. */
export async function registrarSimulacaoCopel(
  data: AllCheckData,
  totalCidade: number,
  entregas: Array<{ id: string; telegram: boolean; pushRecebidos: number; pushFalhas: number }>,
): Promise<string[]> {
  if (!data.copelConsultaOk) return [];
  const db = await getDbClient();
  await db.execute(`CREATE TABLE IF NOT EXISTS copel_simulacao (
    ciclo INTEGER PRIMARY KEY, consumidores INTEGER NOT NULL, ocorrencias TEXT NOT NULL,
    novas TEXT NOT NULL, proposta TEXT NOT NULL, entregas TEXT NOT NULL
  )`);
  await db.execute(`CREATE TABLE IF NOT EXISTS copel_ocorrencias_observadas (
    id TEXT PRIMARY KEY, primeiro_ciclo INTEGER NOT NULL, ultimo_ciclo INTEGER NOT NULL,
    encerrado_em INTEGER, dados TEXT NOT NULL
  )`);
  await db.execute(`CREATE TABLE IF NOT EXISTS copel_alteracoes_observadas (
    id INTEGER PRIMARY KEY AUTOINCREMENT, ciclo INTEGER NOT NULL,
    ocorrencia TEXT NOT NULL, tipo TEXT NOT NULL, dados TEXT NOT NULL
  )`);
  const confirmadas = data.copelOutages.filter(o => (o.tipoPrincipal || "").toUpperCase().includes("INTERRUPCAO"));
  // A contagem soma as linhas da Copel, seguindo o total usado no painel oficial.
  const consumidores = confirmadas.reduce((n, o) => n + (Number(o.qtdConsumidores) || 0), 0);
  const anterior = await db.execute("SELECT consumidores FROM copel_simulacao ORDER BY ciclo DESC LIMIT 1");
  const anteriorTotal = Number(anterior.rows[0]?.consumidores ?? 0);
  const novosConsumidores = data.newCopelOutages.reduce((n, o) => n + (Number(o.qtdConsumidores) || 0), 0);
  const motivos = planejarAvisoCopel(consumidores, anteriorTotal, novosConsumidores, totalCidade);
  const ocorrencias = confirmadas.map(o => ({ id: o.idOcorrencia || o.numeroSequencial, local: o.bairro, consumidores: o.qtdConsumidores, inicio: o.dataInicio, programada: o.ehProgramada, previsao: o.previsaoRestabelecimento }));
  const novas = data.newCopelOutages.map(o => o.idOcorrencia || o.numeroSequencial);
  const atuais = new Map<string, typeof ocorrencias>();
  for (const o of ocorrencias) {
    const id = o.id || `${o.local}|${o.inicio}`;
    const grupo = atuais.get(id) ?? [];
    grupo.push(o);
    atuais.set(id, grupo);
  }
  const anteriores = await db.execute("SELECT id, dados, encerrado_em FROM copel_ocorrencias_observadas");
  const conhecidos = new Map(anteriores.rows.map(r => [String(r.id), r]));
  const operacoes: Array<{ sql: string; args: (string | number | null)[] }> = [];
  for (const [id, grupo] of atuais) {
    const dados = JSON.stringify(grupo.slice().sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
    const anterior = conhecidos.get(id);
    const tipo = !anterior || anterior.encerrado_em != null ? "abertura" : anterior.dados !== dados ? "atualizacao" : null;
    if (tipo) operacoes.push({ sql: "INSERT INTO copel_alteracoes_observadas (ciclo, ocorrencia, tipo, dados) VALUES (?, ?, ?, ?)", args: [data.timestamp, id, tipo, dados] });
    operacoes.push({ sql: `INSERT INTO copel_ocorrencias_observadas (id, primeiro_ciclo, ultimo_ciclo, encerrado_em, dados) VALUES (?, ?, ?, NULL, ?)
      ON CONFLICT(id) DO UPDATE SET ultimo_ciclo=excluded.ultimo_ciclo, encerrado_em=NULL, dados=excluded.dados`, args: [id, data.timestamp, data.timestamp, dados] });
  }
  for (const [id, anterior] of conhecidos) {
    if (anterior.encerrado_em == null && !atuais.has(id)) {
      operacoes.push({ sql: "UPDATE copel_ocorrencias_observadas SET encerrado_em = ? WHERE id = ?", args: [data.timestamp, id] });
      operacoes.push({ sql: "INSERT INTO copel_alteracoes_observadas (ciclo, ocorrencia, tipo, dados) VALUES (?, ?, 'encerramento', ?)", args: [data.timestamp, id, String(anterior.dados)] });
    }
  }
  operacoes.push({ sql: "INSERT OR IGNORE INTO copel_simulacao (ciclo, consumidores, ocorrencias, novas, proposta, entregas) VALUES (?, ?, ?, ?, ?, ?)", args: [data.timestamp, consumidores, JSON.stringify(ocorrencias), JSON.stringify(novas), JSON.stringify(motivos), JSON.stringify(entregas)] });
  await db.batch(operacoes, "write");
  logger.info("Simulação Copel registrada", { ciclo: data.timestamp, consumidores, ocorrencias: atuais.size, novas: novas.length, proposta: motivos });
  return motivos;
}
