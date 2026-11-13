# Contexto do projeto

O nome público **Monitor Ipiranga** corresponde ao projeto Vercel
**servicos-status**, em https://servicos-status.vercel.app.

- Project ID: `prj_XKzUY2gkDG2KtsiNRTOVgddTxOu1`.
- Team ID: `team_7GtY8JazNxndoaRTthkGat89`.
- Team slug: `lucas-andres-projects-0146f21d`.
- Horários comunicados ao usuário: `America/Sao_Paulo`.

As imagens do radar são atualizadas diretamente pelo RainViewer no navegador.
A análise meteorológica vem do estado persistido por `/api/cron`; essas duas
fontes podem ter horários diferentes. Nunca substituir imagens mais recentes
por um estado antigo da API.

Regressão do radar: `node --test scripts/test-radar-refresh.mjs`.
