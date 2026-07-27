# services-health

Monitor unificado de serviços para **Ipiranga - PR**.

Monitora:
- **Operadoras móveis**: Claro, Vivo, TIM (portais, conectividade, BGP)
- **COPEL**: Ocorrências de energia (programadas e emergenciais)
- **Sanepar**: Interrupções programadas de abastecimento de água

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
| `MUNICIPIO` | Município alvo para utilidades | IPIRANGA |
| `COPEL_API_URL` | URL da API COPEL ANEEL | _(fixa)_ |
| `COPEL_TIMEOUT_MS` | Timeout requisição COPEL | 30000 |
| `SANEPAR_VIEWS_AJAX` | URL AJAX Sanepar | _(fixa)_ |
| `SANEPAR_PAGE_URL` | URL página Sanepar | _(fixa)_ |
| `UNIFIED_REPORT_INTERVAL_MS` | Intervalo relatório unificado | 3600000 |

## Execução

```bash
bun run start    # Produção (loop contínuo + HTTP server)
bun run dev      # Desenvolvimento com watch
bun run src/index.ts --once   # Modo cron: executa uma vez e sai
```

## Endpoints (API Interna)

> Todos os endpoints retornam `Content-Type: application/json`.

---

### `GET /health`

Health check do monitor. Retorna status geral e métricas de uptime.

**Resposta:**

| Campo | Tipo | Descrição |
|---|---|---|
| `status` | string | `"healthy"` ou `"degraded"` |
| `level` | string | Nível geral: `"ok"`, `"warn"`, `"critical"` |
| `uptime` | number | Segundos desde a inicialização |
| `operatorCount` | number | Quantidade de operadoras monitoradas |
| `levels` | object | Contagem de operadoras por nível |
| `lastCheck` | number \| null | Timestamp do último ciclo |
| `timestamp` | number | Timestamp da resposta |

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

---

### `GET /api/status`

Status detalhado de **todas as operadoras** (portais, conectividade, BGP).

**Resposta:**

| Campo | Tipo | Descrição |
|---|---|---|
| `level` | string | Nível geral das operadoras |
| `operators[]` | array | Lista de operadoras |
| `operators[].operator` | string | Nome: `"Claro"`, `"Vivo"`, `"TIM"` |
| `operators[].status` | string | `"ok"`, `"warn"`, `"critical"` |
| `operators[].portals[]` | array | Resultados dos portais |
| `operators[].portals[].host` | string | Host do portal |
| `operators[].portals[].success` | boolean | Se respondeu |
| `operators[].portals[].latencyMs` | number | Latência em ms |
| `operators[].portals[].error` | string | Erro (vazio se ok) |
| `operators[].connectivity[]` | array | Testes de conectividade |
| `operators[].connectivity[].label` | string | `"Google"`, `"Cloudflare"`, etc |
| `operators[].bgp` | object \| null | Dados BGP (prefixos) |

```json
{
  "level": "ok",
  "operators": [
    {
      "operator": "Claro",
      "status": "ok",
      "portals": [
        { "host": "minhaclaro.claro.com.br", "success": true, "latencyMs": 234, "error": "" }
      ],
      "connectivity": [
        { "label": "Google", "success": true, "latencyMs": 15, "error": "" }
      ],
      "bgp": { "asn": 28573, "prefixCountV4": 42, "prefixCountV6": 12, "samplePrefixes": ["179.183.0.0/16"], "error": "" }
    }
  ],
  "timestamp": 1712345678000
}
```

---

### `GET /api/services`

Relatório unificado de **todos os serviços**: operadoras + utilidades (COPEL, Sanepar).

É o endpoint principal para consumo por dashboards ou agregadores.

**Resposta:**

| Campo | Tipo | Descrição |
|---|---|---|
| `generatedAt` | number | Timestamp do relatório |
| `overallStatus` | string | `"ok"`, `"warn"` ou `"critical"` (pior entre todos) |
| `services[]` | array | Lista de serviços monitorados |
| `services[].name` | string | Nome do serviço: `"Claro"`, `"Vivo"`, `"TIM"`, `"Copel"`, `"Sanepar"` |
| `services[].category` | string | `"telecom"` ou `"utility"` |
| `services[].status` | string | `"ok"`, `"warn"`, `"critical"` |
| `services[].details` | string | Resumo legível |
| `services[].timestamp` | number | Timestamp da última verificação |
| `services[].data` | object | Dados completos (depende do serviço) |
| `newEvents` | object | Ocorrências novas detectadas no último ciclo |
| `newEvents.copel` | array | Lista de `CopelOutage` |
| `newEvents.sanepar` | array | Lista de `SaneparInterruption` |

**Exemplo:**

```json
{
  "generatedAt": 1712345678000,
  "overallStatus": "warn",
  "services": [
    {
      "name": "Claro",
      "category": "telecom",
      "status": "ok",
      "details": "OK",
      "timestamp": 1712345678000
    },
    {
      "name": "Copel",
      "category": "utility",
      "status": "ok",
      "details": "Sem ocorrências",
      "timestamp": 1712345678000
    },
    {
      "name": "Sanepar",
      "category": "utility",
      "status": "critical",
      "details": "1 interrupção(ões)",
      "timestamp": 1712345678000
    }
  ],
  "newEvents": {
    "copel": [],
    "sanepar": [
      {
        "cidade": "Ipiranga",
        "bairro": "Ipiranga",
        "inicio": "28/07/2026 - 08:00",
        "fim": "28/07/2026 - 17:00",
        "motivo": "Manutenção programada",
        "link": "https://www.sanepar.com.br/esta-sem-agua"
      }
    ]
  }
}
```

---

### `GET /api/report`

Alias para [`/api/services`](#get-apiservices). Mesmo comportamento e resposta.

---

### `GET /api/history?operator=Claro&limit=100`

Histórico de latência dos portais, armazenado no SQLite.

**Parâmetros:**

| Parâmetro | Tipo | Default | Descrição |
|---|---|---|---|
| `operator` | string | _(todos)_ | Filtrar por operadora: `"Claro"`, `"Vivo"`, `"TIM"` |
| `limit` | number | `100` | Máximo de registros (max: 1000) |

**Resposta:** Array de resultados de portal com `operator`, `host`, `success`, `latencyMs`, `error`, `timestamp`.

---

### `GET /api/operators`

Lista as operadoras configuradas.

```json
{ "operators": ["Claro", "Vivo", "TIM"] }
```

---

### `GET /api/bgp`

Últimos 20 resultados de BGP (prefixos anunciados por ASN).

```json
{
  "results": [
    {
      "operator": "Claro",
      "asn": 28573,
      "prefixCountV4": 42,
      "prefixCountV6": 12,
      "samplePrefixes": ["179.183.0.0/16"],
      "timestamp": 1712345678000,
      "error": ""
    }
  ]
}
```

---

### `POST /api/check`

Executa um ciclo completo de verificação **sob demanda**: operadoras (portal + conectividade + BGP) + COPEL + Sanepar.

**Requisição:** Corpo vazio (apenas o POST).

**Resposta:**

```json
{ "status": "ok", "timestamp": 1712345678000 }
```

> ⚠️ A resposta não inclui os resultados. Consulte `GET /api/services` ou `GET /api/status` após o POST.

## Serviços Monitorados

### Operadoras Móveis

| Operadora | ASN | Portal |
|---|---|---|
| Claro | 28573 | minhaclaro.claro.com.br |
| Vivo | 27699 | meuvivo.vivo.com.br |
| TIM | 26615 | meutim.tim.com.br |

Cada operadora é verificada em 3 dimensões:
- **Portal**: requisição HTTPS ao portal da operadora
- **Conectividade**: latência para Google, Cloudflare, 1.1.1.1
- **BGP**: prefixos anunciados via RIPE Stat (ASN)

### Utilidades

#### COPEL (Energia Elétrica)

- **Fonte:** API ANEEL Informações (non-official)
- **Endpoint:** `https://cdn.copel.com/aneel-informacoes/api/portal/mapa_poligonos_data`
- **Método:** GET → JSON com lista de ocorrências
- **Filtro:** `municipio` = valor configurado em `MUNICIPIO`
- **Alertas:** Disparo individual por nova ocorrência (programada ou emergencial)
- **Dedup:** Hash MD5 (`id_ocorrencia + numero_sequencial + data_inicio + bairro`) armazenado no SQLite

#### Sanepar (Abastecimento de Água)

- **Fonte:** Site público + Views AJAX (Drupal)
- **Endpoint AJAX:** `https://www.sanepar.com.br/views/ajax`
- **Fluxo:**
  1. GET na página `/esta-sem-agua` para extrair `view_dom_id` (expressão regular)
  2. POST form-urlencoded para cada display (`supply_stop_desk`, `supply_stop_mobile`)
  3. Parsing do HTML retornado (cards `<article.feat-card-supplystop>`)
- **Filtro:** `cidade` contém "ipiranga" (case insensitive)
- **Alertas:** Disparo individual por nova interrupção
- **Dedup:** Hash MD5 (`cidade + bairro + inicio + fim`) armazenado no SQLite

### Relatório Unificado

A cada `UNIFIED_REPORT_INTERVAL_MS` (default: 1h), um relatório consolidado de **todos os serviços** é enviado ao Telegram, mostrando o status de cada um e o status geral.

## Alertas

| Tipo | Gatilho | Frequência |
|---|---|---|
| Operadoras | Mudança de nível (ok → warn/critical) | Agregado por ciclo |
| COPEL | Nova ocorrência em Ipiranga | Por evento |
| Sanepar | Nova interrupção em Ipiranga | Por evento |
| Relatório unificado | Intervalo configurável | Periódico |

## Arquitetura

```
src/
├── index.ts          # Entry point, HTTP server, main loop
├── config.ts         # Config via env vars
├── types.ts          # Tipos compartilhados
├── logger.ts         # Log estruturado JSON
├── telegram.ts       # Envio de alertas Telegram
├── db.ts             # SQLite (resultados + dedup)
├── state.ts          # EventTracker (dedup de eventos)
├── checker.ts        # Orquestrador unificado
└── probes/
    ├── portal.ts     # Probe portal operadora
    ├── connectivity.ts # Probe conectividade
    ├── bgp.ts        # Probe BGP
    ├── copel.ts      # Probe COPEL
    └── sanepar.ts    # Probe Sanepar
```

## Adicionar Novo Serviço (Extensibilidade)

1. Criar probe em `src/probes/novoServico.ts`
   - Função que retorna `TipoEvento[]` (ou dados de health check)
   - Usar `EventTracker` para dedup se necessário
2. Adicionar tipo em `src/types.ts` se necessário
3. Em `src/checker.ts`, adicionar chamada no `runAllChecks()`
4. Adicionar entrada `ServiceHealth` no report
5. Se houver alerta por evento, criar `sendNovoServicoAlert()` em `telegram.ts`
6. Adicionar config no `src/config.ts` e `.env.example`

## Cron / Systemd Timer

Para executar verificações sob demanda via cron:

```bash
# Executa a cada 5 minutos
*/5 * * * * /usr/local/bin/bun run /opt/services-health/src/index.ts --once >> /var/log/services-health-cron.log 2>&1
```