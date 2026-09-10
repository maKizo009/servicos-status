#!/usr/bin/env python3
"""Médias descritivas por evento — estudo Tibagi/Bitumirim.

Lê as séries diárias SIH (uvaia_AAAA.txt, lajeado_AAAA.txt) e, para cada
janela de evento, imprime SOMENTE estatística descritiva:
  pico (cm + data) por estação, média 7d ao redor do pico, defasagem
  Lajeado→Uvaia em dias.
NÃO classifica, NÃO conclui, NÃO sugere limiar. Saída: CSV no stdout.
Uso: python3 media-eventos.py [dir-sih]
"""
import csv
import glob
import os
import sys
from datetime import date

EVENTOS = [
    ("out-nov/2025", date(2025, 10, 20), date(2025, 11, 10)),
    ("jan/2025", date(2025, 1, 15), date(2025, 1, 25)),
    ("dez/2024", date(2024, 12, 1), date(2024, 12, 20)),
    ("out-nov/2023", date(2023, 10, 20), date(2023, 11, 15)),
    ("out-nov/2022", date(2022, 10, 20), date(2022, 11, 10)),
    ("jun/2022", date(2022, 6, 1), date(2022, 6, 30)),
    ("jan/2021", date(2021, 1, 1), date(2021, 1, 31)),
    ("mai-jun/2019", date(2019, 5, 15), date(2019, 6, 30)),
    ("jun/2017", date(2017, 6, 1), date(2017, 6, 30)),
    ("jul/2015", date(2015, 7, 1), date(2015, 7, 31)),
    ("out/2015", date(2015, 10, 1), date(2015, 10, 31)),
    ("jun/2014", date(2014, 6, 1), date(2014, 6, 30)),
    ("jun-jul/2013", date(2013, 6, 1), date(2013, 7, 31)),
    ("jun/2012", date(2012, 6, 1), date(2012, 6, 30)),
    ("ago/2011", date(2011, 8, 1), date(2011, 8, 31)),
]

ESTACOES = ["uvaia", "lajeado"]


def carregar(diretorio):
    """{estacao: {date: nivel_cm}} — ignora linhas sem leitura numérica."""
    dados = {e: {} for e in ESTACOES}
    for caminho in glob.glob(os.path.join(diretorio, "*.txt")):
        base = os.path.basename(caminho)
        est = next((e for e in ESTACOES if base.startswith(e + "_")), None)
        if est is None:
            continue
        with open(caminho, encoding="utf-8", errors="replace") as f:
            for linha in f:
                p = linha.split()
                if len(p) < 7 or not p[6].lstrip("-").isdigit():
                    continue
                try:
                    d = date(int(p[1]), int(p[2]), int(p[3]))
                except ValueError:
                    continue
                dados[est][d] = int(p[6])
    return dados


def janela_stats(serie, ini, fim):
    pts = sorted((d, v) for d, v in serie.items() if ini <= d <= fim)
    if not pts:
        return None
    pico_d, pico_v = max(pts, key=lambda x: x[1])
    return {
        "n_dias": len(pts),
        "pico_cm": pico_v,
        "pico_data": pico_d.isoformat(),
        "media_cm": sum(v for _, v in pts) / len(pts),
    }


def baseline(dados):
    """P10/P50/P90/P98 da série completa por estação (nível 'normal')."""
    import statistics
    linhas = []
    for est, serie in sorted(dados.items()):
        vs = sorted(serie.values())
        if not vs:
            continue
        q = statistics.quantiles(vs, n=100, method="inclusive")
        linhas.append({
            "estacao": est,
            "n_dias": len(vs),
            "p10": q[9],
            "p50": q[49],
            "p90": q[89],
            "p98": q[97],
            "max": vs[-1],
        })
    return linhas


def main():
    diretorio = sys.argv[1] if len(sys.argv) > 1 else "."
    dados = carregar(diretorio)
    if len(sys.argv) > 2 and sys.argv[2] == "baseline":
        w = csv.writer(sys.stdout)
        w.writerow(["estacao", "n_dias", "p10_cm", "p50_cm", "p90_cm", "p98_cm", "max_cm"])
        for b in baseline(dados):
            w.writerow([b["estacao"], b["n_dias"], b["p10"], b["p50"], b["p90"], b["p98"], b["max"]])
        return
    w = csv.writer(sys.stdout)
    w.writerow([
        "evento", "janela_ini", "janela_fim",
        "uvaia_n_dias", "uvaia_pico_cm", "uvaia_pico_data", "uvaia_media_cm",
        "lajeado_n_dias", "lajeado_pico_cm", "lajeado_pico_data",
        "lajeado_media_cm", "lag_pico_dias_laj_para_uvaia",
    ])
    for nome, ini, fim in EVENTOS:
        u = janela_stats(dados["uvaia"], ini, fim)
        l = janela_stats(dados["lajeado"], ini, fim)
        if u is None or l is None:
            w.writerow([nome, ini, fim, *(["sem-dados"] * 3), *(["sem-dados"] * 3), "sem-dados"])
            continue
        lag = (
            date.fromisoformat(u["pico_data"]) - date.fromisoformat(l["pico_data"])
        ).days
        w.writerow([
            nome, ini, fim,
            u["n_dias"], u["pico_cm"], u["pico_data"], round(u["media_cm"], 1),
            l["n_dias"], l["pico_cm"], l["pico_data"], round(l["media_cm"], 1),
            lag,
        ])


if __name__ == "__main__":
    main()
