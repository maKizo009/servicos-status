# services-health

Monitor de conectividade móvel para operadoras **Claro**, **Vivo** e **TIM** na cidade de **Ipiranga - PR**.

## Stack

- **Runtime:** Bun 1.3+
- **Linguagem:** TypeScript
- **Banco:** SQLite (bun:sqlite) com WAL mode
- **HTTP:** Servidor nativo Bun
- **Logs:** JSON estruturado (Loki/ELK ready)
- **Alertas:** Telegram (Markdown)

## Configuração

Copie `.env.example` para `.env` e preencha:

| Variável | Descrição | Default |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | Token do bot Telegram | — |
| `TELEGRAM_CHAT_ID` | Chat ID para alertas | — |
| `CHECK_INTERVAL_MS` | Intervalo entre ciclos (ms) | 60000 |
| `HTTP_PORT` | Porta do servidor | 3000 |

## Endpoints

### `GET /health`

Health check do próprio monitor.

```json
{
  "status": "healthy",
  "level": "ok",
  "uptime": 3600,
  "operatorCount": 3,
  "levels": { "critical": 0, "warn": 0, "ok": 3 },
  "lastCheck": 1712345678000,
  "timestamp": 1712345679000
}
```

### `GET /api/status`

Status atual de todas as operadoras (portais, conectividade geral, BGP).

### `GET /api/history?operator=Claro&limit=100`

Histórico de latência dos portais. Filtro opcional por operadora.

### `GET /api/operators`

Lista as operadoras monitoradas.

```json
{ "operators": ["Claro", "Vivo", "TIM"] }
```

### `GET /api/bgp`

Últimos 20 resultados de BGP (prefixos anunciados por ASN).

### `POST /api/check`

Executa um ciclo de verificação sob demanda.

## Execução

```bash
bun run start    # Produção
bun run dev      # Desenvolvimento com watch
```

## Operadoras Monitoradas

| Operadora | ASN | Portal |
|---|---|---|
| Claro | 28573 | minhaclaro.claro.com.br |
| Vivo | 27699 | meuvivo.vivo.com.br |
| TIM | 26615 | meutim.tim.com.br |