---
target: painel Monitor Ipiranga
total_score: 24.5
max_score: 40
na_heuristics: 
p0_count: 2
p1_count: 3
timestamp: 2026-08-23T13-07-19Z
slug: src-public-index-html
---
# Critique — Monitor Ipiranga (`src/public/index.html`)

Method: dual-agent (A: design director subagent deleg_32de6d5f · B: detector subagent deleg_bb0ea82d [detector completo executado; verificação de FPs concluída no contexto pai após esgotamento do budget do subagente])

## Design Health Score (Nielsen, 0-4 cada)

| # | Heurística | Score | Achado-chave |
|---|-----------|-------|--------------|
| 1 | Visibilidade do status | 3 | "Atualizado há 12s" + dot pulsante excelentes; mas telemetria sem amostra mostra "🟢 NORMAL" (ausência de dado como confirmação) |
| 2 | Match com mundo real | 2 | Jargão no caminho do morador: "Roteamento BGP Nacional (AS…)", "dBZ", "VLM", "ECMWF" |
| 3 | Controle do usuário | 2 | Acordeão de ocorrências reseta a cada refresh de 30s (renderCards refaz innerHTML); fullscreen CSS-falso (Esc não sai) |
| 4 | Consistência | 2 | Dois sistemas de ícone (SVG vs ~30 emojis); primária M3 sky-blue definida e nunca usada; theme-color ≠ header |
| 5 | Prevenção de erros | 3 | Engenharia defensiva rara: esc() anti-XSS, debounce, timeouts, retry no push |
| 6 | Reconhecimento > recall | 3 | Tiles-letter das operadoras bons; pill "Sua Conexão" ambíguo (minha internet ou da cidade?) |
| 7 | Flexibilidade | 3 | /llms.txt, JSON-LD, dBZ bruto, banner com tabindex+onkeydown — tudo para power user, nada progressivo pro leigo |
| 8 | Estética minimalista | 1.5 | Box "AI-First & LLM Friendly" (6 ações) na sidebar ao lado do boletim de tempestade; 3 superfícies dev/AI competindo |
| 9 | Recuperação de erros | 2 | showError() apaga TODO o grid com copy técnico exatamente quando a tempestade derruba o 4G do usuário |
| 10 | Ajuda/documentação | 2.5 | Disclaimer honesto, mas referencia "previsão numérica (ECMWF)" que não existe em lugar nenhum da UI |
| **Total** | | **24.5/40** | **Acceptable — base sólida, falhas de foco e resiliência** |

## Design Specificity Verdict

Dois momentos autorais genuínos: header verde-floresta e complexo radar+nowcast com setas de projeção. Entre eles, dashboard Material genérico que sobreviveria em qualquer SaaS de uptime. Identidade "chuva/tempo/Paraná" existe só no dado, nunca na forma. **Alerta de marca**: o verde institucional (#00923F no theme-color) é EXATAMENTE o verde da Copel (--copel:#00923F) — o app arrisca ser lido como propriedade da concessionária que fiscaliza.

Determinístico (detector): 23 findings — nested-cards ×6, low-contrast ×4, tiny-text ×4, dark-glow ×3, undersized-ui-text ×3, overused-font (Inter) ×1, pulsing-dot ×1, em-dash-overuse ×11 ocorrências. Verificados contra o código: todos reais exceto nuances — (a) os "nested cards" vêm majoritariamente de blocos internos funcionais dentro da weather-section/card (banner-detail-item, kpi-card), parte é ruído real de dupla-caixa; (b) dark-glow do header (#047857 shadow sob gradiente verde) é sombra de elevação intencional, mas os glows dos ov-dots e --shadow-crit são glow puro; (c) white-on-#4ADE80 (1.7:1) confirmado nos botões do mapa em tema claro via var(--g6).

## Overall Impression

Painel tecnicamente competente com cultura rara de honestidade de dados, mas falha justo no seu momento-definição: tempestade com rede instável. O maior oportunidade é transformar alarmes empilhados numa única voz calma e dar à interface uma frase-de-consolo que hoje não existe.

## What's Working

1. Disciplina WCAG no dark mode — overrides explícitos trocando texto branco por #7F1D1D sobre vermelho claro (comentados no código)
2. Banner→card acessível por teclado (tabindex+onkeydown+scrollIntoView+highlight)
3. Honestidade de copy: formatCopelPrevisao eliminando contradições, separação determinístico-vs-VLM, disclaimer de IA

## Priority Issues

**[P0] showError() destrói informação na hora de maior necessidade** — durante temporal o 4G cai e a resposta da UI é apagar tudo e falar "API". Correção: manter último render (dimmed) + overlay "Dados de 14:32 — não consegui atualizar. [Tentar de novo]" + cache localStorage do último payload. Sugerido: harden

**[P0→resolvido nesta passada] Sem prefers-reduced-motion com 4 fontes de animação simultâneas em cenário crítico** — bannerGlow infinito + badge pulse 1.5s + ov-dot pulse 1s + footer pulse 2s. Ansiedade amplificada, bateria, acessibilidade vestibular.

**[P1] Junk drawer de IA/dev no caminho do morador** — box LLM (6 ações) ao lado do boletim de tempestade; pill "Sua Conexão" ambíguo. Mover LLM box pra footer; pill ganha contexto ("sua internet", não da cidade).

**[P1] Contraste WCAG AA violado** — branco sobre var(--g6)=#16A34A/#4ADE80 nos botões do mapa/erro (1.7:1–3.8:1); texto essencial a 10–11px com opacity .65-.8.

**[P1] Camada de tradução ausente** — BGP/dBZ/UCs sem gloss; a pergunta do morador ("vou ficar sem luz?") nunca respondida em frase direta.

**[P2] Tells de UI-de-IA + micro-tipografia** — side-tab borders, glows coloridos, Inter, textos 10-11.5px, sem h1, touch targets <44px, transition:width.

## Persona Red Flags

**Seu Antônio, 68**: escala px trava a fonte-grande dele; BGP ocupando o card que deveria responder "vou ficar sem luz?"; layer-btns ~26px de alvo; BUG REAL: Copel e Sanepar compartilham o id `copelOutagesList` (toggle colapsa lista errada); `cityTotalConsumers || 5200` inventa dado apresentado como fato.

**Dave, power user**: adora llms-full.txt/dBZ/tabular-nums; padece com maxNativeZoom 7 borrado, attribution desligada, fullscreen sem Esc, acordeão resetando a cada 30s, sem deep-link de estado na URL.

## Minor Observations

- theme-color #00923F ≠ gradiente do header; e é verde-Copel
- Escudo do header tem semântica de antivírus; gota+escudo seria autoral
- Token inexistente --text-secondary usado em .cemaden-24h-label e #cemadenContent (herda cor por acidente)
- role="alert" + aria-live="polite" contraditórios (alert implica assertive)
- Estado inicial do banner diz "3 OK" hardcoded antes do fetch
- Refresh duplica como relógio ("Aguarde..." substitui a hora)
- Sem atribuição OSM/Esri no mapa (obrigação de licença)
- "Fonte Oficial ↗" mereceria destaque no estado crítico
- 11 em-dashes no copy (densidade IA)

## Questions to Consider

1. Se a tempestade derrubar o 4G às 20:01, o que a tela diz? Por que o app não guarda o próprio último-suspiro?
2. O verde do header pertence ao Monitor Ipiranga ou à Copel?
3. Qual é a ÚNICA frase que um usuário assustado precisa ler num temporal — e por que ela não existe na página?
