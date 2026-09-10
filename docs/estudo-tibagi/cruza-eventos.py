#!/usr/bin/env python3
"""Cruzamento chuva × nível por evento — só descritiva, sem veredito.

Entradas:
  chuva-climanalytics.csv  (estacao_id,data,precipitacao — diário, mm)
  medias-eventos.csv       (picos SIH Uvaia/Lajeado por janela)
Saída: CSV no stdout — por evento e estação de chuva: total na janela,
máx diária + data; + colunas SIH (picos, lag) repetidas para referência.
Uso: python3 cruza-eventos.py [dir]
"""
import csv
import os
import sys
from datetime import date

ESTACOES_CHUVA = ["1101", "1105", "2056", "2241", "IAT_2450054", "83811", "83813"]

# Arquivos extras de chuva (mesmo formato lógico): (caminho, prefixo_id, colunas)
# chuva-sih.csv: estacao_id,estacao_nome,data,mm (IAT: Itaicoca/Apiaba/Bocaina)
# chuva-sma.csv: estacao_id,estacao_nome,data,mm (ABC: Bela Vista/PG/Tibagi/...)


def ler_chuva(caminho):
    """{estacao: {date: mm}}"""
    dados = {}
    with open(caminho, encoding="utf-8") as f:
        for est, d, mm in csv.reader(f):
            if est not in ESTACOES_CHUVA:
                continue
            try:
                dados.setdefault(est, {})[date.fromisoformat(d)] = float(mm)
            except ValueError:
                continue
    return dados


def ler_chuva_extra(caminho, id_col=0, data_col=2, mm_col=3):
    """{estacao: {date: mm}} para chuva-sih.csv / chuva-sma.csv (sem filtro)."""
    dados = {}
    try:
        f = open(caminho, encoding="utf-8")
    except FileNotFoundError:
        return dados
    with f:
        r = csv.reader(f)
        next(r, None)  # cabeçalho
        for row in r:
            if len(row) <= max(id_col, data_col, mm_col):
                continue
            try:
                dados.setdefault(row[id_col], {})[date.fromisoformat(row[data_col])] = float(
                    row[mm_col]
                )
            except ValueError:
                continue
    return dados


def main():
    d = sys.argv[1] if len(sys.argv) > 1 else "."
    chuva = ler_chuva(os.path.join(d, "chuva-climanalytics.csv"))
    # prefixa extras para não colidir (sih: / sma:)
    for cod, serie in ler_chuva_extra(os.path.join(d, "chuva-sih.csv")).items():
        chuva[f"sih:{cod}"] = serie
    for cod, serie in ler_chuva_extra(os.path.join(d, "chuva-sma.csv")).items():
        chuva[f"sma:{cod}"] = serie
    todas = ESTACOES_CHUVA + sorted(k for k in chuva if ":" in k)
    with open(os.path.join(d, "medias-eventos.csv"), encoding="utf-8") as f:
        eventos = list(csv.DictReader(f))
    w = csv.writer(sys.stdout)
    w.writerow([
        "evento", "janela_ini", "janela_fim", "estacao_chuva",
        "n_dias_chuva", "chuva_total_mm", "chuva_max_diaria_mm",
        "chuva_max_data", "uvaia_pico_cm", "uvaia_pico_data",
        "lajeado_pico_cm", "lajeado_pico_data", "lag_dias",
    ])
    for ev in eventos:
        ini = date.fromisoformat(ev["janela_ini"])
        fim = date.fromisoformat(ev["janela_fim"])
        for est in todas:
            serie = chuva.get(est, {})
            pts = [(dd, v) for dd, v in serie.items() if ini <= dd <= fim]
            if not pts:
                tot, mx, mxd, n = "sem-dados", "sem-dados", "sem-dados", 0
            else:
                mxd, mx = max(pts, key=lambda x: x[1])
                tot = round(sum(v for _, v in pts), 1)
                n = len(pts)
                mxd = mxd.isoformat()
            w.writerow([
                ev["evento"], ev["janela_ini"], ev["janela_fim"], est,
                n, tot, mx, mxd,
                ev.get("uvaia_pico_cm"), ev.get("uvaia_pico_data"),
                ev.get("lajeado_pico_cm"), ev.get("lajeado_pico_data"),
                ev.get("lag_pico_dias_laj_para_uvaia"),
            ])


if __name__ == "__main__":
    main()
