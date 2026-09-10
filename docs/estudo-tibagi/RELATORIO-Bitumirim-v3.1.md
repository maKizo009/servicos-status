# Cheias do Rio Bitumirim (Ipiranga-PR): do dado ao algoritmo v3.1

Relatório técnico completo — estudo Tibagi/SIH 2011–2026 + SMA ABC + CEMADEN + rótulos de campo.
Versão: 11/09/2026. Status dos modelos: IFL v3.1 + permanência (preliminar n=2) EM PRODUÇÃO em servicos-status.vercel.app.
Arquivo-irmão pronto p/ importar no NotebookLM (este .md faz upload direto em "Adicionar fontes").

---

## 1. Objetivo e área de estudo

Prever em linguagem simples, com fórmula aberta e sem inventar número: (a) QUANDO o Rio Bitumirim
sai da caixa (flash, horas) e (b) SE sair, quantos dias fica fora (permanência, dias).

- Rio Bitumirim: afluente do Rio Tibagi pela margem direita; foz em -25,0049, -50,4279 (OSM).
- Ipiranga-PR não possui estação fluviométrica própria; o Bitumirim nunca foi medido direto.
- Sentinela útil ao vivo: Uvaia 64444000, ~8,8 km ao sul da foz (praticamente Ipiranga).
- Segundo ponto: Lajeado 64442800 (~1,2 km ao sul da foz). Barrinha a 7,5 km ao norte; Moinho ~1 km.
- Tibagi corre para o NORTE; foz do Bitumirim ~110 km ao SUL de Mauá (-24,0419, -50,6939).
- Resultado negativo registrado: o Rio Ivaí é OUTRA bacia (deságua direto no Paraná; Tibagi vai ao
  Paranapanema). Descargas de barragens do Ivaí (ex. Santa Clara) NÃO têm mecanismo físico para
  afetar o Bitumirim — seria preciso o Paraná empurrar água centenas de km contra a corrente.
  Coincidências de data entre bacias = mesmo sistema de chuva regional, causa local permanece.

## 2. Fontes de dados (todas públicas ou de campo, todas verificáveis)

| # | Fonte | O que entrega | Acesso / mecânica validada |
|---|---|---|---|
| F1 | ANA SIH-Web, cotas | Séries horárias/diárias Uvaia 64444000 + Lajeado 64442800, 2011–2026 (TXT+XLS, 0 divergências) | http://www.sih-web.aguasparana.pr.gov.br — `gerarRelatorioCotasFluviometricas.do`, `codBacia=16`, `anoAtual=2026`, JSESSIONID; jars em /tmp/sih_jar.txt |
| F2 | ANA SIH-Web, chuva | Alturas diárias de precipitação, mesmos anos | `gerarRelatorioAlturasDiariasPrecipitacao.do` + `leituraCadastrada=true`; nomes via ajax `carregarNomeEstacaoAjax`; plu: 2056 São Braz, 1101 Suruvi, Bocaina, 2549052 Itaicoca, Teixeira, 2241, 2244, PG CDE/Rosário, 2320 Bela Vista, 2550043 Apiaba |
| F3 | SMA Fundação ABC | Chuva diária + Temp Solo + Potencial água no solo (mps, kPa) + Molhamento (dpm) + Radiação + UR + vento + pressão, janela 31d/request | POST `https://sma.fundacaoabc.org/monitoramento/grafico/diario_dados` (`cod_area_estacao`, `data=DD/MM/AAAA`); horária em `horario_dados`; calendário em `calendario`. Highcharts: temp do ar serializa com aspas simples (regex separado); categorias vêm com barra escapada (`15\/09`); `data` é array flat |
| F4 | CEMADEN | Chuva ao vivo Ipiranga, 2 estações: G2-411050801A e G2-411050802A (acc1/3/6/12/24/48/72/96h; em 10/09/26 20:10 UTC: 67,6 vs 35,4 mm/24h — hiper-localidade provada) | `https://resources.cemaden.gov.br/graficos/interativo/getJson2.php?uf=PR` (sem login). Só chuva, SEM solo |
| F5 | Climanalytics PG | Chuva diária histórica (backup `chuva-climanalytics.csv`, 72.642 B) | host lucas-leo@debian, docker clima_postgres |
| F6 | OSM/Overpass | 424 cursos d'água (`rios-osm-ipiranga.json`) + foz e distâncias | Overpass API |
| F7 | Rótulos de campo (Dave) | 11 rótulos de transbordo (`rotulos-bitumirim.csv`): fotos + régua + memória | Ver Seção 4 |
| F8 | SMA ABC coordenadas corrigidas | 2056 São Braz −25,0000,−50,5855 830 m (N de Ipiranga) · 1101 Suruvi −25,0580,−50,3300 800 m (L) · 1105 Rosário · 2241 Balsa Nova | Voronoi + barometria + SRTM (skill sma-abc-weather) |

Fontes REJEITADAS com motivo: SIMEPAR (403 Cloudflare, sem API pública); Wunderground API antiga
morta em 2018 (503), nova exige key paga e sem PWS confirmada em Ipiranga; INMET (timeout);
CEMADEN em PG/Imbituva (zero estações); IAT chuva (sem registro); radar Teixeira Soares (off);
Google Fotos do autor (ele optou por fornecer datas manualmente).

## 3. Baseline estatístico (SIH 2011–2026, ano hidrológico 365d)

| Estação | P50 | P90 | P98 | Máx | Faixa atenção/alerta (365d) | vazaoP98 |
|---|---|---|---|---|---|---|
| Uvaia 64444000 | 166 | 392 | 708 | 1232 | 385 / 455 cm | 225 m³/s |
| Lajeado 64442800 | 208 | 470 | 660 | 868 | (faixa própria) | — |
| Cebolão 64504210 (Londrina, JUSANTE ~180 km — fora da lógica de risco) | — | — | — | — | 337 / 360 cm | 1119 m³/s |
| Jataizinho 64507000 (jusante) | — | — | — | 1430 (OUT23) | 263 / 301 cm | 949 m³/s |

- Lag Lajeado→Uvaia: 1–6 dias, moda 3–4 (15 eventos em `medias-eventos.csv`).
- Cruzamento final: 360 linhas × 24 séries (`cruzamento-eventos.csv`).
- P98 diário Uvaia (708) ≈ transbordo prático ~730 (OUT23: 732,6 cm às 16h de 29/10, +5 cm/h).
- Picos Uvaia (SIH diário): 2011-08-07: 934 · 2012-06-15: 645 · 2013-06-28: 1033 (Lajeado 795 em 24/06)
  · 2014-06-13: 995 (Lajeado 868 em 10/06) · 2015-07-22: 986 (Lajeado 797 em 18/07)
  · 2017-06-13: 659 (Lajeado 690 em 11/06) · 2019-06-07: 921 (Lajeado 772 em 03/06)
  · 2021-01-30: 673 · 2022-06-11: 595 · 2022-11-07: 406 · 2023-11-04: 1232 (horária pico 1189 em 03/11 06h)
  · 2024-12-16: 888 (horária pico 815 em 13/12 23:45) · 2025-01-23: 228 · 2025-11-10: 333.

## 4. Rótulos de transbordo (verdade de campo, 11)

| Rótulo | Data/hora | Observação | Uvaia | Chuva local |
|---|---|---|---|---|
| OUT23 | 29/10/23 18h → 05/11 | SAIU (rodovia interditada), 7 dias fora | ~739 na saída; pico 1189 | São Braz 323 mm/4d |
| DEZ24 | 09/12/24 ~13h → 12/12 | SAIU (atravessou rodovia), 3 dias fora | 339 na saída (!<P90); pico 815 | São Braz 149 (07/12)+21+128 (09/12); 421 mm/30d |
| JAN25 | 21/01/25 07:29 | NÃO saiu (régua 4 m no máximo) | 180 (P50) | São Braz 143 (19/01)+14,8+0,4; Suruvi 21,8 |
| INV2013 | 28/06/13 | SAIU — o mais dramático dos invernos | 1033 | São Braz 412 mm/30d, max3d 184, rad 7,7 |
| INV2014 | 13/06/14 | SAIU — médio | 995 | 259 mm/30d, max3d 126, rad 8,4 |
| INV2015 | 22/07/15 | SAIU — médio | 986 | São Braz 329/Suruvi 301 mm/30d, max3d ~70–81, rad ~8 |
| INV2017 | 13/06/17 | SAIU — menor | 659 | São Braz 319/Suruvi 297/Bela Vista 260 mm/30d, max3d ~101–135, rad ~7–9 |
| INV2019 | 07/06/19 | SAIU — menor | 921 | 311 mm/30d, max3d 97, rad 8,9 |
| 2011 | 07/08/11 (1º dom de ago) | SAIU (memória) | 934 | — (pré-SMA) |

Leituras-chave: (i) DEZ24 transbordou com Uvaia em 339 (<P90) → **chuva local causa o transbordo**;
(ii) JAN25 quase transbordou com Uvaia em P50 → Tibagi calmo não impede flash;
(iii) severidade dos invernos (13>14≈15>19>17, Dave) reproduzida pelo pico Uvaia
(1033/995/986/921/659) e NÃO pela pilha local (2017 2ª maior pilha e "menor").

## 5. Estudo de saturação do solo (SMA 2056/1101/2320)

- `linha_mps` existe na 2056 desde 2013 (31/31 dias na janela OUT23) e responde à chuva
  (141→88 kPa no dia de 88 mm), MAS **satura no piso (~11 kPa) e fica lá**: DEZ24 inteiro em ~11,
  4 dos 5 invernos no piso, JAN25 em 11,05 no dia da leitura. Não discrimina verão (ambos saturados)
  e é anti-correlacionado entre estações (OUT23, a maior cheia, com mps 88–155, "seco").
  CONCLUSÃO: mps e molhamento (dpm) FICAM FORA da fórmula (teste negativo registrado).
- Caveat dpm: unidade mudou no tempo ("min" no horário/antigo vs "Horas" no diário atual) — normalizar antes de qualquer uso.
- Suruvi (1101) NÃO tem sensor de solo (9 séries, sem `linha_mps`).
- Bela Vista (2320) entrou no ar ~ago/2015 (janela JUL15 toda zerada); em 2017 confirma o manto regional (~260 mm, solo no piso).
- Visão mensal (2056): NOV24 144 mm → mps médio 58, saturado 17/31d (solo respirava);
  DEZ24 421 mm → 31/31d no piso; JUL24 102 mm, maxdia 19 → saturado 21/31d com radiação 8,7
  (metade do verão 17–20). **O inverno arma o palco com pouca água porque quase nada evapora.**
- Saturação é melhor reconstruída com chuva+radiação (ambas disponíveis) do que com o próprio sensor.

## 6. Doutrina sazonal (a tese central deste relatório)

| Regime | Estação | Física | Quem manda | Prova |
|---|---|---|---|---|
| Convectivo | set–abr | célula hiper-local (até 2× de chuva dentro de Ipiranga no mesmo dia: 67,6 vs 35,4) | SÓ o local (IFL puro); Uvaia chega dias depois e só diz os dias fora | JAN25 |
| Frontal | mai–ago | frente fria ampla, manto regional ~300 mm/mês em 3 estações | Uvaia integra a bacia e carrega a SEVERIDADE; chuva local não discrimina médio/menor | invernos 13–19 |

## 7. Algoritmo v3.1 (em produção)

- **Regime**: `regimeDoMes(m) = frontal se 5≤m≤8`. Confirmação offline: radiação média 30d
  São Braz < 12 MJ/m²/dia em todos os 6 invernos e em nenhum verão. Ao vivo usa só o mês
  (determinístico, zero fetch novo).
- **IFL (flash, 0–1)**: base = 0,5·min(p1/35,1)+0,5·min(p6/70,1); p24≥90 → piso 0,75 (assinatura JAN25);
  p1≥40 → 1,0 (curto-circuito); **antecedente v3.1**: p72≥150 (convectivo) ou ≥100 (frontal) →
  piso 0,35 = palco armado, nunca passa de amarelo sozinho. Níveis: ≥0,8 vermelho · ≥0,5 laranja · ≥0,3 amarelo.
- **Permanência (PRELIMINAR n=2)**: dias = máx(0, arred0,5(0,0107×Uvaia − 5,7)); +1d se Uvaia subindo ≥50 cm/24h.
  É condicional ("SE transbordar, ~X dias"), nunca previsão de transbordo.
- **Drenagem bloqueada**: Uvaia em atenção/alerta + ≥10 mm/6h em Ipiranga → watch (o que transbordar demora a descer).
- **Conservadorismo**: "critical" nunca gerado pelo algoritmo; cheia se confirma por Defesa Civil (199)/IAT.
  Disclaimer verbatim no card, no `/llms.txt` e na fórmula aberta.
- Replays: DEZ24 09/12 (p24 128) → laranja ✓; JAN25 21/01 manhã (p24 ~15, p72 ~158) → amarelo com rio em 4 m descendo ✓;
  OUT23 29/10 (p24 ~97+) → laranja ✓. Invernos sem replay diário (datas exatas de saída desconhecidas — só picos Uvaia) = limitação declarada.

## 8. Validação e estado

18 testes hidro (37 expects) + suíte (8+10+6+4+9+43) = 98 pass, 0 fail; `tsc --noEmit` limpo;
produção verificada via `/api/weather` (set/26: regime convectivo, IFL 0,17 verde, permanência 0d).
IBR v1/v2 aposentados com motivo (v1: Antas a jusante tratado como montante; v2: Cebolão em
Londrina como "calha na foz"); auditoria externa Antigravity registrada em /tmp/agy-ibr/.

## 9. Limitações honestas (não usar sem ler)

1. Permanência ajustada em n=2 — toda foto nova com data/hora refina; sem régua no Bitumirim, só o "quando", nunca o "quanto" (nível em metros no local).
2. Sem datas exatas de saída nos invernos — o acoplamento frontal é direcional, não calibrado por replay.
3. CEMADEN Ipiranga só desde 08/2026 — replays usam SMA diário como proxy (resolução menor que acc1/6h).
4. mps/dpm fora da fórmula (Seção 5); antecedente é chuva acumulada, não umidade medida.
5. Espacial: 2056 ao N, 1101 ao L — temporal no centro/sul pode errar as duas (caso 08/10/2015: 8 mm nas estações, calamidade na cidade).
6. Uvaia ≠ Bitumirim: 2019 teve Uvaia 921 e Bitumirim "menor" — o regional carrega severidade, não destino local.

## 10. Arquivos e reprodução

- Código: `src/ana-hidro.ts` (IFL, permanência, regime), `src/cemaden.ts`, `src/index.ts` (p72h), `src/llm-formatter.ts`, `src/public/index.html` (fórmula aberta), `scripts/test-hidro-cotas.ts`, `scripts/check-hidro-card.ts`.
- Dados: `docs/estudo-tibagi/` — `rotulos-bitumirim.csv` (11), `medias-eventos.csv` (15), `cruzamento-eventos.csv` (360×24), `chuva-sma.csv` (7.012, 14 estações), `chuva-climanalytics.csv`, `rios-osm-ipiranga.json` (424), `raw-sma/` + `raw-sma-solo/` (HTML Highcharts crus), `puxar_sma.py`, `media-eventos.py`, `cruza-eventos.py`.
- Checagem ao vivo: `curl -s https://servicos-status.vercel.app/api/weather` (campos `hidro.ifl`, `hidro.permanencia`, `hidro.regime`).
- SMA (ex.): `POST sma.fundacaoabc.org/monitoramento/grafico/diario_dados cod_area_estacao=2056&data=DD/MM/AAAA`.
- CEMADEN: `GET resources.cemaden.gov.br/graficos/interativo/getJson2.php?uf=PR` (filtrar `cidade=IPIRANGA`).

## 11. Referências

[1] Revistas IFPR — bacia do Bitumirim (mundietg art. 2516). [2] Mundo Educação — enchentes/várzeas.
[3] G1 Caminhos do Campo 12/11/23 — fumo debaixo d'água. [4] ANA biblioteca sophia (111793).
[5] Zenodo 16929471. [6] Globoplay 12074660/12077071; G1 Campos Gerais 31/10/23 — 7 mil ilhados em Ipiranga.
El Niño 2023/24 (segundo semestre intenso, frentes bloqueadas no Sul). COBRADE 1.3.2.1.3, Decreto 106/2015 (temporal granizo 08/10/15 — fora da série de cheias, citado como prova hiper-local).
