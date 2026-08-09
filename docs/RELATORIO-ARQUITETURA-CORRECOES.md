# Relatório de Arquitetura — Correções servicos-status

> **Gerado por:** Hermes (Kimi K3) + Claude Opus 4.6 Thinking (via agy)
> **Data:** 2026-08-09
> **Base:** Auditoria externa do Cláudio (7 achados) validada contra o código real em `/root/servicos-status`
> **Objetivo deste documento:** Servir como prompt completo para um agente de IA implementar as correções. NÃO é uma descrição genérica — contém arquivo:linha exato, tipo de mudança, e ordem de execução.

---

## Placar de Vereditos

| # | Achado (Cláudio) | Veredito | Evidência-chave |
|---|------------------|----------|-----------------|
| 1 | `/llms.txt` desatualizado | ✅ **CONFIRMADO** | `src/index.ts:455-464` — sem staleness check que `/api/weather` tem (linha 509) |
| 2 | Boletim VLM contradiz ETA | 🟡 **PARCIAL** | `src/nowcast-vlm.ts:254-263` — sem validação pós-geração; prompt mitiga mas não garante |
| 3 | Latência portal → CRITICAL | ✅ **CONFIRMADO** | `src/checker.ts:122-132` — `some()` + `>300ms` com `success=true` dispara critical |
| 4 | Timeout = falha, sem debounce | ✅ **CONFIRMADO** | `src/probes/portal.ts:80-88` + `checker.ts:110` — timeout vira `!success` → critical instantâneo |
| 5 | Rótulo "Telefonia Móvel" ≠ métrica | ✅ **CONFIRMADO** | `src/llm-formatter.ts:144` — mede portal web, rotula como rede móvel |
| 6 | COPEL soma sem dedupe | 🟡 **PARCIAL** | `src/checker.ts:229-231` — `reduce` sem dedupe; risco teórico (API raramente duplica) |
| 7 | Instruções inline no payload | ✅ **CONFIRMADO** | `src/llm-formatter.ts:146-168` — "Instruções para Agentes de IA" misturado com dados |

---

## ARQUITETURA PROPOSTA — VISÃO CONSOLIDADA

### Ordem de Prioridade (Impacto × Esforço)

| Prioridade | Achado | Severidade | Esforço | Justificativa |
|-----------|--------|-----------|---------|---------------|
| **P0** | 4 — Timeout/debounce | 🔴 Alta | Médio | Falsos positivos de alerta Telegram |
| **P0** | 3 — Latência → critical | 🔴 Alta | Baixo | Portal lento = "rede fora" engana cidadão |
| **P1** | 7 — Prompt injection | 🟠 Média-Alta | Baixo | Vetor arquitetural real |
| **P1** | 1 — `/llms.txt` stale | 🟠 Média | Baixo | Credibilidade do serviço |
| **P2** | 5 — Rótulo incorreto | 🟡 Média | Trivial | Semântica/confiança |
| **P2** | 2 — VLM sem validação | 🟡 Média | Médio | Qualidade do boletim |
| **P3** | 6 — COPEL dedupe | 🟢 Baixa | Trivial | Robustez defensiva |

### Dependências

```
Achado 4 (debounce) ──→ Achado 3 (reclassificar latência)  [MESMO PR]
      │
      └──→ Achado 1 (staleness /llms.txt)
Achado 7 (separar instruções) ──→ Achado 5 (renomear rótulo)
Achado 3 ──→ Achado 5
Achado 2 (validação VLM) -.-> Achado 7
Achado 6 (dedupe COPEL) -.-> Achado 1
```

> **IMPORTANTE:** Achados 3 e 4 DEVEM ser corrigidos no mesmo PR — ambos alteram `assessLevel()` e os critérios de alerta. Corrigir um sem o outro cria inconsistência.

---

## PLANO DE IMPLEMENTAÇÃO DETALHADO

### Sprint 1 (P0) — Eliminar falsos positivos de alerta

#### Tarefa 1.1 — Distinguir timeout de falha + debounce (Achado 4)

**Arquivos afetados:**
- `src/types.ts` — adicionar tipo `ProbeOutcome` ou estender `PortalResult`/`ConnectivityResult`
- `src/probes/portal.ts:80-88` — timeout retorna `{ success: false, error: "Timeout" }` → mudar para incluir flag `timeout: true` ou status ternário
- `src/probes/connectivity.ts:36-44` — mesma mudança
- `src/checker.ts:103-140` — `assessLevel()` deve tratar timeout como `warn`, não `critical`
- `src/index.ts:72-207` — `runChecks()` precisa de contador de falhas consecutivas antes de disparar alerta

**Mudança arquitetural:**
1. Em `types.ts`, criar:
   ```typescript
   export type ProbeStatus = "ok" | "timeout" | "failure";
   // PortalResult e ConnectivityResult ganham campo opcional:
   // probeStatus?: ProbeStatus (ou substituir success: boolean)
   ```
2. Em `portal.ts` e `connectivity.ts`: quando `err.message` contém "timeout"/"timed out", retornar `probeStatus: "timeout"` (não `success: false` puro).
3. Em `checker.ts` `assessLevel()`:
   - `portalFailures` conta apenas `probeStatus === "failure"` (não timeout)
   - `portalTimeouts` conta `probeStatus === "timeout"` → vira `warn`, não `critical`
   - Manter `connectivityFailures` (timeout de Google/Cloudflare é mais grave — indica rede local)
4. Debounce em `index.ts` `runChecks()`:
   - Manter `Map<string, number> consecutiveFailures` (chave = `${operator}:${host}`)
   - Só promover para `critical` após **2 falhas consecutivas** (com `checkIntervalMs` = 60s, são ~2 min de confirmação)
   - Resetar counter quando `probeStatus === "ok"`
   - Persistir counters em memória (ou Turso se quiser sobreviver a cold start — opcional, não obrigatório)

**Riscos:**
- Debounce adiciona ~1-2 min de atraso na detecção de falha real. Aceitável (alertas Telegram já têm latência natural).
- Mudança em `PortalResult` pode quebrar `db.ts` (save/get). Verificar `savePortalResult` e `getPortalHistory` — podem precisar de migração de schema ou campo adicional.

#### Tarefa 1.2 — Reclassificar latência de portal para `warn` (Achado 3)

**Arquivos afetados:**
- `src/checker.ts:122-137` — `assessLevel()`
- `src/checker.ts:203-209` — `buildUnifiedReport()` (texto de detalhes)

**Mudança arquitetural:**
1. Em `assessLevel()`, separar:
   - `criticalLatencyConnectivity` = `connectivity.some(c => c.latencyMs > latencyCritMs && c.success)` → mantém `critical` (rede lenta de verdade)
   - `criticalLatencyPortal` = `portals.some(p => p.latencyMs > latencyCritMs && p.success)` → **move para `warn`**
2. A condição `critical` fica: `portalFailures > 0 || connFailures > 0 || bgpZeroPrefixes || criticalLatencyConnectivity`
3. A condição `warn` fica: `highLatency || criticalLatencyPortal || portalTimeouts > 0`
4. Em `buildUnifiedReport()` linha 203-206: atualizar texto — "Latência crítica no portal (>300ms)" → "Portal lento (>300ms)" e garantir que não aparece como "critical"

**Riscos:**
- Portal genuinamente sob DDoS (latência spike) vira `warn`. Aceitável — se a rede (connectivity) estiver OK, o serviço móvel provavelmente está funcionando.
- Revisar `sendTelegramAlert` em `telegram.ts` — textos de alerta podem precisar de ajuste para refletir que `warn` por latência não é "crítico".

---

### Sprint 2 (P1) — Integridade e segurança dos dados

#### Tarefa 2.1 — Separar instruções do payload `/llms.txt` (Achado 7)

**Arquivos afetados:**
- `src/llm-formatter.ts:146-168` — remover seções "Instruções para Agentes de IA" e "Regras de Uso para Agentes"
- `src/index.ts:455-465` — handler `/llms.txt`
- `src/index.ts` — adicionar handler para `/llms-instructions.txt` (novo endpoint)
- `vercel.json` — adicionar rewrite para `/llms-instructions.txt`

**Mudança arquitetural:**
1. Criar função `renderLlmsInstructions()` em `llm-formatter.ts` que retorna APENAS as instruções (sem dados).
2. `/llms.txt` passa a conter: dados + metadados neutros + uma única linha no final: `> Para instruções de uso por agentes de IA, consulte: /llms-instructions.txt`
3. Sanitização: antes de interpolar qualquer variável no template do `/llms.txt`, aplicar função `sanitizeLlmField(text, maxLen)`:
   - Remove/escapa headers markdown (`##` → `\#\#` ou strip)
   - Trunca em `maxLen` (ex: 500 chars para campos de texto livre)
   - Escapa backticks e template literals
4. Campos que DEVEM ser sanitizados: `bulletin` (VLM), `copelStatus`, `saneparStatus`, `details` (de todos os serviços), `condition` (weather)
5. O `sanitizeLlmField` vive em `llm-formatter.ts` como função interna.

**Riscos:**
- Agentes que consomem `/llms.txt` esperando instruções inline perdem contexto. Mitigado pela linha de redirecionamento.
- Sanitização pode corromper markdown legítimo do VLM. Mitigar com whitelist: permite negrito, itálico, listas com `-`; remove headers, HTML, links.

#### Tarefa 2.2 — Staleness check no `/llms.txt` (Achado 1)

**Arquivos afetados:**
- `src/index.ts:455-465` — handler `/llms.txt`

**Mudança arquitetural:**
1. Replicar a lógica de `/api/weather` (linhas 509-511):
   ```typescript
   let state = getCachedWeatherState();
   if (!state || Date.now() - state.updatedAt > 600_000) {
       state = await syncWeatherCycle();
   }
   ```
2. Ajustar `Cache-Control`: de `public, max-age=300` para `public, max-age=120, stale-while-revalidate=60` (alinha com ciclo de cron de 5 min).
3. Adicionar timestamp de geração real no corpo: já existe `${nowStr}` no template (linha 121) — garantir que é `new Date().toISOString()` calculado na hora da requisição (já é — linha 70 de `llm-formatter.ts`).
4. Adicionar segundo timestamp indicando idade dos dados subjacentes:
   ```
   > Dados meteorológicos atualizados em: ${new Date(state.updatedAt).toISOString()}
   > Este documento foi gerado nesta requisição às: ${nowStr}
   ```

**Riscos:**
- `syncWeatherCycle()` no handler adiciona latência (fetch ECMWF + RainViewer). Mitigar com `stale-while-revalidate` na CDN.
- Se o Vercel Cron estiver configurado (verificar `vercel.json` ou dashboard), o sync já roda periodicamente — o staleness check é apenas fallback para instâncias frias.

---

### Sprint 3 (P2) — Qualidade semântica

#### Tarefa 3.1 — Renomear rótulo "Telefonia Móvel e Internet" (Achado 5)

**Arquivos afetados:**
- `src/llm-formatter.ts:144` — rótulo
- `src/llm-formatter.ts:108-115` — `telecomSummary`

**Mudança arquitetural:**
1. Linha 144: `"Telefonia Móvel e Internet"` → `"Portais de Autoatendimento (Claro/Vivo/TIM)"`
2. Adicionar linha de contexto após o rótulo:
   ```
   - **Nota:** Este indicador mede a disponibilidade dos portais web de autoatendimento das operadoras, não a qualidade do sinal celular local. Dados de sinal real são coletados via crowdsourcing quando disponíveis.
   ```
3. Quando `signalReport` ou `crowdsourcedState` estiver presente (já existe em `checker.ts:169-189`), o rótulo muda dinamicamente para indicar fonte real de dados de rede.

**Riscos:**
- Mínimo. Parsers downstream que buscam "Telefonia Móvel" quebram. Documentar no changelog.

#### Tarefa 3.2 — Validação pós-geração do VLM (Achado 2)

**Arquivos afetados:**
- `src/nowcast-vlm.ts:254-263` — após receber texto do VLM

**Mudança arquitetural:**
1. Após `const text = json.choices?.[0]?.message?.content?.trim()`, aplicar validações:
   ```typescript
   // a) Se verdict.approach === "receding" mas o texto diz "aproximando"/"vindo"/"chegando"
   //    → fallback para buildHeuristicBulletin(nowcast)
   // b) Extrair ETA do texto: /ETA\s*~?\s*(\d+)\s*min/i ou /(\d+)\s*min(?:utos)?/i
   //    Se |etaExtraído - verdict.etaMin| > verdict.etaMin * 0.5 → log warning + fallback
   // c) Se o texto contém headers markdown (##) ou instruções ("ignore", "system")
   //    → sanitizar ou fallback
   ```
2. Se qualquer validação falhar: logar `logger.warn("VLM contradisse veredito determinístico", { verdict, text })` e usar `buildHeuristicBulletin(nowcast)`.
3. Alternativa (menos frágil): no `/llms.txt`, separar o ETA calculado do texto do VLM — emitir como campo próprio não-sobrescrevível:
   ```
   - **ETA calculado (determinístico):** ${etaMin} min
   - **Análise IA (VLM):** ${bulletin}
   ```

**Riscos:**
- Regex frágil → falsos negativos. Mitigar com threshold generoso (50%) e log para tuning.
- Fallback excessivo perde valor do VLM. Monitorar frequência de fallback nos logs.

---

### Sprint 4 (P3) — Robustez defensiva

#### Tarefa 4.1 — Dedupe COPEL por `idOcorrencia` (Achado 6)

**Arquivos afetados:**
- `src/checker.ts:229-231` — `buildUnifiedReport()`
- Opcionalmente `src/probes/copel.ts:65` — dedupe na source

**Mudança arquitetural:**
1. Em `buildUnifiedReport()`, antes do `reduce`:
   ```typescript
   const uniqueOutages = new Map(
       data.copelOutages.map(o => [o.idOcorrencia || `${o.bairro}-${o.dataInicio}`, o])
   );
   const copelTotalConsumers = [...uniqueOutages.values()].reduce(
       (sum, o) => sum + (o.qtdConsumidores || 0), 0
   );
   ```
2. Fallback para dedupe na source (`copel.ts`): antes de `allOutages.push(outage)`, verificar se `idOcorrencia` já existe no array.
3. Adicionar assertion de integridade:
   ```typescript
   if (copelTotalConsumers !== data.copelOutages.reduce(...)) {
       logger.warn("COPEL: possível duplicata detectada", { ... });
   }
   ```

**Riscos:**
- Dedupe por `idOcorrencia` pode esconder ocorrências legítimas se a COPEL reutilizar IDs (improvável).
- O `makeHash` em `copel.ts:67-73` inclui `qtdConsumidores` — mesma ocorrência com contagem atualizada é vista como "nova". Decidir: manter versão mais recente ou maior contagem.

---

## Checklist de Verificação Pós-Implementação

Após cada sprint, verificar:

- [ ] **Sprint 1:** Simular timeout de portal → deve virar `warn`, não `critical`. Simular 2 timeouts consecutivos → só no 2º vira alerta.
- [ ] **Sprint 1:** Simular latência >300ms em portal → deve ser `warn`, não `critical`. Simular latência >300ms em connectivity (Google) → mantém `critical`.
- [ ] **Sprint 2:** `/llms.txt` não contém "Instruções para Agentes de IA". `/llms-instructions.txt` existe e contém apenas instruções.
- [ ] **Sprint 2:** Dois requests seguidos a `/llms.txt` com 11 min de intervalo → segundo request tem timestamp atualizado.
- [ ] **Sprint 3:** Texto do VLM que diz "2 horas" quando ETA calculado é 196 min → fallback para heurístico.
- [ ] **Sprint 4:** API COPEL retornando mesma `idOcorrencia` 2x → soma total não duplica.

---

## Arquivos Críticos (referência rápida)

| Arquivo | Linhas-chave | O que faz |
|---------|-------------|-----------|
| `src/index.ts` | 455-465 | Handler `/llms.txt` (sem staleness check) |
| `src/index.ts` | 504-514 | Handler `/api/weather` (COM staleness check — modelo a copiar) |
| `src/checker.ts` | 103-140 | `assessLevel()` — classificação ok/warn/critical |
| `src/checker.ts` | 229-231 | Soma COPEL sem dedupe |
| `src/llm-formatter.ts` | 66-169 | `renderLlmsTxt()` — template completo |
| `src/llm-formatter.ts` | 146-168 | Seções de instrução inline (prompt injection) |
| `src/nowcast-vlm.ts` | 99-291 | `generateNowcastBulletin()` — prompt VLM + fallback |
| `src/nowcast-vlm.ts` | 254-263 | Aceita texto VLM sem validação |
| `src/probes/portal.ts` | 80-88 | Timeout → `success: false` |
| `src/probes/connectivity.ts` | 36-44 | Timeout → `success: false` |
| `src/weather-collector.ts` | 240-246 | Cache em memória sem TTL |
| `src/config.ts` | 63 | `latencyCritMs = 300` |
| `src/radar-analysis.ts` | 503-539 | `assessThreat()` — calcula ETA determinístico |
