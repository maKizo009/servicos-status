# ACHADOS — Pentest servicos-status.vercel.app (2026-08-12)

Auditoria autorizada do DaveString: recon externo (sem ler o código) + scan de
secrets via GLM 5.2 (NVIDIA NIM, function calling) + revisão para correção.

## Achados (antes)

| # | Severidade | Achado | Correção |
|---|-----------|--------|----------|
| 1 | 🟥 | `/api/cron` sem auth — qualquer um disparava o ciclo completo (cota NIM + Telegram + push p/ todos os inscritos) | Exige `Authorization: Bearer <CRON_SECRET>` **ou** header `x-vercel-cron: 1` + rate limit dedicado 2/min/IP (escopo `cron`) |
| 2 | 🟥 | `/api/push/test` sem auth — spam de push para todos os assinantes do PWA | Exige sessão admin (cookie `mi_admin` validado) |
| 3 | 🟠 | `/api/check` POST sem auth — disparava probes + NIM + alertas (DoS de custo) | Exige `Authorization: Bearer <CRON_SECRET>` (env `CRON_SECRET`, setada no Vercel) |
| 4 | 🟠 | CORS `access-control-allow-origin: *` global (wrapper + OPTIONS) | Whitelist de origens (`servicos-status.vercel.app`, `os-status.vercel.app`, `localhost:3030`) + `Vary: Origin` |
| 5 | 🟠 | Headers de segurança ausentes: CSP, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Permissions-Policy (só HSTS) | CSP + XFO DENY + nosniff + referrer + permissions-policy no wrapper da API e no `src/public/_headers` (estáticos) |
| 6 | 🟠 | XSS no front: `cs.details`, `ws.details`, `item.bairro`, `item.title`, `item.details` (dados Copel/Sanepar/telecom) interpolados em `innerHTML` sem escape | Helper `esc()` aplicado em TODAS as interpolações de dados da API no `index.html` |
| 7 | 🟠 | Erros internos vazavam mensagens/stack (`{error: msg}` em 500 e nos catches 400) | Respostas genéricas (`Erro interno` / `Requisição inválida`) + log server-side com detalhe |
| 8 | 🟡 | Login admin sem lockout dedicado (só escopo `admin` 20/min + delay 1.2s) | Escopo `login` 5/min por IP (além do delay existente) |
| 9 | 🟡 | `/api/status` e outras rotas de leitura respondiam 200 para POST/PUT/DELETE/PATCH | Rota de leitura → 405 com `Allow: GET, HEAD` (whitelist `READ_ONLY_PATHS`) |
| 10 | 🟡 | `/api/telemetry` POST e `/api/signal-report` POST rodavam `runChecks()` a cada request (DoS de custo) | Removido — ciclo roda no cron/worker |
| 11 | 🟡 | `/api/history?limit=-5` retornava o histórico inteiro (sem clamp) | Clamp: ausente/0/negativo/NaN → 100; teto 1000 |
| 12 | 🟢 | `/api/admin/me` sem auth revelava `configured: true` (admin existe) | `configured` só quando autenticado |
| 13 | 🟢 | `.env.example` com URL Turso real (`health-lucasmodesto.aws-us-east-2`) — vazava topologia (achado GLM 5.2) | Placeholder `your-database-name.your-org` |
| 14 | ⚪ | Comentário `GEMINI_API_KEY=...` no script de teste (achado GLM 5.2, falso positivo) | Ajustado para `<sua-chave>` + aviso de nunca commitar |

## Scan de secrets (GLM 5.2 via NIM — ferramenta `scan_for_secrets`)

- Pass 1 (críticos, min-confidence 3): **0 achados** em 62 arquivos
- Pass 2 (amplo, min-confidence 1): **2 achados** (nº 13 e 14 acima, ambos low/informational)
- Verdicto do modelo: codebase **limpo de secrets vivos**

## Coisas que NÃO são vulnerabilidade (testadas)

- SQLi em `/api/history?operator=`: valor tratado como string literal (parametrizado)
- XSS refletido no JSON do `/api/history`: Content-Type `application/json` (não executável no browser)
- `/api/admin/stats` sem sessão: 401 ✓; `/api/admin/me` sem sessão: `authed:false` ✓
- Rate limit global 10/min (default), 120/min (track), 20/min (admin): ativos ✓
- Auth admin: scrypt + timing-safe, sessão HMAC-SHA256 30d, cookie HttpOnly+SameSite+Secure ✓
- WebAuthn: whitelist de rpID/origin, challenge uso-único + TTL 5 min ✓

## Ações manuais pendentes (dependem do Dave)

1. **Disparador do `/api/cron`**: se o cron atual NÃO for o cron nativo do Vercel
   (header `x-vercel-cron: 1`), o disparador externo (cron-job.org, GitHub
   Actions, etc.) precisa mandar `Authorization: Bearer <CRON_SECRET>`.
   O secret está em `/root/.cron_secret_servicos` (fora do repo).
2. Envs estranhas no Vercel: `TURSO_DATABASE_URL_TURSO_DATABASE_URL` e
   `TURSO_DATABASE_URL_TURSO_AUTH_TOKEN` parecem lixo de setup antigo — avaliar
   remoção (não mexido para não quebrar nada).

## Rescan pós-correção

- [ ] headers (CSP/XFO/nosniff/referrer/permissions) presentes
- [ ] CORS sem `*`
- [ ] métodos de escrita → 405 nas rotas de leitura
- [ ] `/api/check` e `/api/cron` → 401 sem credencial
- [ ] `/api/push/test` → 401 sem sessão
- [ ] login → 429 após 5 tentativas/min
- [ ] `/api/history?limit=-5` → no máx. 100 registros
- [ ] `/api/admin/me` sem auth → `configured:false`
