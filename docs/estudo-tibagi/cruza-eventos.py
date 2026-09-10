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


def main():
    d = sys.argv[1] if len(sys.argv) > 1 else "."
    chuva = ler_chuva(os.path.join(d, "chuva-climanalytics.csv"))
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
        for est in ESTACOES_CHUVA:
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
