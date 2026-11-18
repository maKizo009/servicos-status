import { createHash } from "node:crypto";
import { getDbClient } from "./db.js";
import { listPushSubscriptions, pushConfigured, sendPushAlert } from "./push.js";
import { sendTelegramAlert } from "./telegram.js";
import type { AllCheckData } from "./checker.js";

export class ErroEnfileiramentoCopel extends Error {}

/** Guarda uma linha por destino, para que uma falha não repita envios concluídos. */
export async function processarAvisosCopelAgrupados(data: AllCheckData, motivos: string[], botToken: string, chatId: string, totalCidade = 6017): Promise<void> {
  let db: Awaited<ReturnType<typeof getDbClient>>;
  try {
    db = await getDbClient();
    await db.execute(`CREATE TABLE IF NOT EXISTS copel_fila_agrupada (
      chave TEXT PRIMARY KEY, criado_em INTEGER NOT NULL, titulo TEXT NOT NULL,
      corpo TEXT NOT NULL, endpoint TEXT, nivel TEXT NOT NULL, pendente INTEGER NOT NULL,
      ids TEXT NOT NULL, municipal INTEGER NOT NULL, estado TEXT NOT NULL,
      tentativas INTEGER NOT NULL, ultima_tentativa INTEGER
    )`);
  } catch (error) {
    throw new ErroEnfileiramentoCopel(String(error));
  }
  const ativas = data.copelOutages.filter(o => (o.tipoPrincipal || "").toUpperCase().includes("INTERRUPCAO"));
  const total = ativas.reduce((s, o) => s + (Number(o.qtdConsumidores) || 0), 0);
  const todasProgramadas = ativas.length > 0 && ativas.every(o => o.ehProgramada);
  const temProgramadas = ativas.some(o => o.ehProgramada);
  const tituloMunicipal = `⚡ ${todasProgramadas ? "Desligamento programado" : "Energia"} em Ipiranga: ${total} unidades afetadas`;
  const locaisAtivos = [...new Set(ativas.map(o => o.bairro).filter(Boolean))];
  const corpoMunicipal = `A Copel informa ${total} unidades afetadas em ${locaisAtivos.join(", ") || "Ipiranga"}.${temProgramadas ? " Há desligamento programado entre as ocorrências." : ""} Consulte o painel para detalhes e previsão.`;
  const fingerprint = (partes: string[]) => createHash("sha256").update(JSON.stringify(partes)).digest("hex");
  const mensagens: Array<{ sql: string; args: (string | number)[] }> = [];
  const adicionar = async (evento: string, titulo: string, corpo: string, nivel: string, ids: string[], localidade?: string) => {
    const subs = await listPushSubscriptions(localidade);
    mensagens.push(...subs.map(sub => ({ sql: "INSERT OR IGNORE INTO copel_fila_agrupada VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, 'pendente', 0, NULL)", args: [`${evento}:push:${fingerprint([sub.endpoint])}`, data.timestamp, titulo, corpo, sub.endpoint, nivel, JSON.stringify(ids), localidade === undefined ? 1 : 0] })));
    if (localidade === undefined) mensagens.push({ sql: "INSERT OR IGNORE INTO copel_fila_agrupada VALUES (?, ?, ?, ?, NULL, ?, 1, ?, 1, 'pendente', 0, NULL)", args: [`${evento}:telegram`, data.timestamp, titulo, corpo, nivel, JSON.stringify(ids)] });
  };
  try {
  if (motivos.length) {
    const ids = [...new Set(ativas.map(o => o.idOcorrencia || o.numeroSequencial || `${o.bairro}|${o.dataInicio}`))].sort();
    const nivel = motivos.some(m => m.includes("10%")) ? "critical" : "warn";
    await adicionar(`municipal:${fingerprint([...ids, nivel])}`, tituloMunicipal, corpoMunicipal, nivel, ids);
  } else if (data.newCopelOutages.length > 0) {
    const localidades = [...new Set(data.newCopelOutages.map(o => o.bairro).filter(Boolean))];
    for (const localidade of localidades) {
      const lista = data.newCopelOutages.filter(o => o.bairro === localidade);
      const ids = lista.map(o => o.idOcorrencia || o.numeroSequencial || `${o.bairro}|${o.dataInicio}`).sort();
      const programada = lista.every(o => o.ehProgramada);
      await adicionar(`local:${fingerprint([localidade, ...ids])}`, `⚡ ${programada ? "Desligamento programado" : "Falta de energia"} em ${localidade}`, `A Copel informa ocorrência em ${localidade}. Consulte o painel para detalhes e previsão.`, "warn", ids, localidade);
    }
  }
  } catch (error) {
    throw new ErroEnfileiramentoCopel(String(error));
  }
  // Em timeout o resultado do lote é incerto. A próxima execução tenta as
  // mesmas chaves, evitando combinar um envio alternativo com um lote gravado.
  if (mensagens.length) await db.batch(mensagens, "write");
  // Um aviso atrasado por mais de quatro horas pode descrever uma queda encerrada.
  await db.execute({ sql: "UPDATE copel_fila_agrupada SET pendente = 0, estado = 'expirado' WHERE criado_em < ? AND pendente = 1", args: [Date.now() - 4 * 3600_000] });
  const pendentes = await db.execute("SELECT * FROM copel_fila_agrupada WHERE pendente = 1 ORDER BY criado_em ASC");
  const idsAtivos = new Set(ativas.map(o => o.idOcorrencia || o.numeroSequencial || `${o.bairro}|${o.dataInicio}`));
  for (const row of pendentes.rows) {
    const ids = JSON.parse(String(row.ids)) as string[];
    const municipal = Number(row.municipal) === 1;
    const desatualizado = ids.some(id => !idsAtivos.has(id)) || (municipal && (ids.length !== idsAtivos.size || total < 20));
    if (desatualizado) {
      await db.execute({ sql: "UPDATE copel_fila_agrupada SET pendente = 0, estado = 'desatualizado' WHERE chave = ?", args: [String(row.chave)] });
      continue;
    }
    const titulo = municipal ? tituloMunicipal : String(row.titulo);
    const corpo = municipal ? corpoMunicipal : String(row.corpo);
    const nivel = municipal && totalCidade > 0 && total >= totalCidade * 0.1 ? "critical" : "warn";
    let ok = false;
    let estado = "falhou";
    if (row.endpoint == null) {
      ok = await sendTelegramAlert({ botToken, chatId, level: nivel, summary: `${titulo}\n${corpo}` });
      if (ok) estado = "aceito";
    } else if (pushConfigured()) {
      const entrega = await sendPushAlert(titulo, corpo, "/", undefined, String(row.endpoint));
      ok = entrega.falhas === 0;
      if (ok) estado = entrega.ok > 0 ? "aceito" : "inscricao_ausente";
    }
    await db.execute({ sql: "UPDATE copel_fila_agrupada SET pendente = ?, estado = ?, tentativas = tentativas + 1, ultima_tentativa = ?, nivel = ? WHERE chave = ?", args: [ok ? 0 : 1, estado, Date.now(), nivel, String(row.chave)] });
  }
}
