# Estudo Tibagi/Bitumirim — dados e scripts determinísticos

Constituição: nenhum número é chutado ou gerado por LLM. Tudo aqui vem de
arquivo baixado (XLS/TXT do SIH, CSV do Climanalytics) e script versionado.

## Fontes primárias (tudo em `sih/`)

| arquivo | origem |
|---|---|
| `uvaia_AAAA.{xls,txt}` | SIH-Web/IAT, est. 64444000 Uvaia, cota diária 7h (cm) |
| `lajeado_AAAA.{xls,txt}` | SIH-Web/IAT, est. 64442800 Lajeado, cota diária 7h (cm) |
| `chuva-climanalytics.csv` | PG `meteorological.observacoes_diarias` (ABC/IAT/INMET) |

XLS é a fonte primária; TXT é espelho (verificação 32/32 arquivos,
~11,4 mil leituras, **0 divergências**).

## Scripts (rodar com python com `xlrd`; ex.: `/tmp/xlsenv`)

- `ler_xls_sih.py` — parser da matriz SIH (ano × dia × mês), sem interpolação
- `media-eventos.py sih` → `medias-eventos.csv` (pico/data/média/lag, 15 janelas)
- `media-eventos.py sih baseline` → `baseline.csv` (P10/P50/P90/P98 da série)
- `cruza-eventos.py .` → `cruzamento-eventos.csv` (chuva × nível por evento)

## Geografia confirmada (não inferida)

- Foz do Bitumirim: -25,0049, -50,4279 (Wikidata/OSM)
- Uvaia: -25,0756 (8,8 km a montante da foz) — única telemétrica útil
- Cebolão (64504210): Londrina, -23,4502 — JUSANTE (~180 km), fora do cálculo
- Antas: 1,1 km a jusante da casa de força de Mauá — fora do cálculo
- Lajeado→Uvaia: lag de pico 1–6 dias (moda 3–4) em 15 eventos
