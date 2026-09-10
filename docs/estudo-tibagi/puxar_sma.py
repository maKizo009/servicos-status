#!/usr/bin/env python3
"""Puxa chuva diária SMA ABC (diario_dados, 30d por request) — só descritivo.

Uso: python3 puxar-sma.py
Saída: chuva-sma.csv (estacao,data,mm) + raws em raw-sma/
Meses cobertos: todos os das 15 janelas de evento com SMA disponível (2015+).
"""
import csv
import json
import os
import re
import time
import urllib.parse
import urllib.request

BASE = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(BASE, "raw-sma")
os.makedirs(RAW, exist_ok=True)

ESTACOES = {
    "2320": "Imbituva Bela Vista",
    "1124": "Ponta Grossa CDE",
    "1105": "Ponta Grossa Rosario",
    "2529": "Ponta Grossa Santa Cruz",
    "1112": "Tibagi Fortuna",
    "2904": "Tibagi Hirooka",
    "2745": "Tibagi Lagoa",
    "2305": "Tibagi Lavras",
    "1133": "Tibagi Sao Bento",
    "2749": "Teixeira Soares Don Lysandro",
    "2730": "Teixeira Soares Limeira",
    "2733": "Fernandes Pinheiro Bituva",
    "1224": "Castro CDE",
    "819": "Castro-PR",
    "2411": "Palmeira Ursula",
}

# Meses fora da cobertura da estação voltam vazios (calendario/ modesto).
# Coberturas parciais (via /grafico/calendario):
#  2733: 06/2023→ | 1224: 12/2018→ | 2411: 09/2022→ | 819: →12/2022
#  2730: 06/2023→ | 2749: 05/2026→ (fora de todas as janelas — ignorada)
MESES_POR_ESTACAO = {
    "2733": [(2023, 9), (2023, 10), (2023, 11), (2024, 11), (2024, 12),
             (2025, 1), (2025, 9), (2025, 10), (2025, 11)],
    "2730": [(2023, 9), (2023, 10), (2023, 11), (2024, 11), (2024, 12),
             (2025, 1), (2025, 9), (2025, 10), (2025, 11)],
    "1224": [(2019, 4), (2019, 5), (2019, 6), (2020, 12), (2021, 1),
             (2022, 5), (2022, 6), (2022, 9), (2022, 10), (2022, 11),
             (2023, 9), (2023, 10), (2023, 11), (2024, 11), (2024, 12),
             (2025, 1), (2025, 9), (2025, 10), (2025, 11)],
    "2411": [(2022, 9), (2022, 10), (2022, 11),
             (2023, 9), (2023, 10), (2023, 11), (2024, 11), (2024, 12),
             (2025, 1), (2025, 9), (2025, 10), (2025, 11)],
    "819": [(2015, 9), (2015, 10), (2017, 5), (2017, 6),
            (2019, 4), (2019, 5), (2019, 6), (2020, 12), (2021, 1),
            (2022, 5), (2022, 6), (2022, 9), (2022, 10), (2022, 11)],
    "2749": [],  # só existe desde 05/2026 — fora de todas as janelas
}

# (ano, mes) padrão: meses dos eventos + mês anterior (chuva antecedente).
# Jul/15 e anteriores sem SMA (rede inicia 08/2015).
MESES = [
    (2015, 9), (2015, 10),
    (2017, 5), (2017, 6),
    (2019, 4), (2019, 5), (2019, 6),
    (2020, 12), (2021, 1),
    (2022, 5), (2022, 6), (2022, 9), (2022, 10), (2022, 11),
    (2023, 9), (2023, 10), (2023, 11),
    (2024, 11), (2024, 12),
    (2025, 1),
    (2025, 9), (2025, 10), (2025, 11),
]

URL = "https://sma.fundacaoabc.org/monitoramento/grafico/diario_dados"


def ultimo_dia(ano, mes):
    import calendar as cal
    return cal.monthrange(ano, mes)[1]


def buscar(cod, ano, mes):
    data = f"{ultimo_dia(ano, mes):02d}/{mes:02d}/{ano}"
    req = urllib.request.Request(
        URL,
        data=urllib.parse.urlencode(
            {"cod_area_estacao": cod, "data": data}
        ).encode(),
        headers={"User-Agent": "Mozilla/5.0", "X-Requested-With": "XMLHttpRequest"},
    )
    for tentativa in range(3):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return r.read().decode("utf-8", errors="replace")
        except Exception:
            time.sleep(2 + tentativa * 2)
    return ""


def extrair_chuva(html):
    """(categorias, valores) da série Precipitação Pluvial (mm), ou ([], [])."""
    i = html.find('"title":{"text":"Precipita')
    if i < 0:
        return [], []
    j = html.find('"series":[{"data":[', i)
    if j < 0:
        return [], []
    k = html.find("]", j + 19)
    try:
        raw = json.loads("[" + html[j + 19 : k] + "]")
    except json.JSONDecodeError:
        return [], []
    c0 = html.rfind('"categories":[', 0, i)
    c1 = html.find("]", c0 + 14)
    try:
        cats = json.loads("[" + html[c0 + 14 : c1].replace("\\/", "/") + "]")
    except json.JSONDecodeError:
        return [], []
    if len(cats) != len(raw):
        return [], []
    # null = sem leitura no dia (estação offline); preserva posição p/ data
    vals = [float(v) if v is not None else None for v in raw]
    return cats, vals


def periodo_base(html):
    m = re.search(r"odo: (\d{2})\\/(\d{2})\\/(\d{4})", html)
    if not m:
        return None
    return int(m.group(3)), int(m.group(2)), int(m.group(1))


def main():
    saida = os.path.join(BASE, "chuva-sma.csv")
    n = 0
    with open(saida, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["estacao_id", "estacao_nome", "data", "mm"])
        for cod, nome in ESTACOES.items():
            for ano, mes in MESES_POR_ESTACAO.get(cod, MESES):
                arq = os.path.join(RAW, f"{cod}_{ano}-{mes:02d}.html")
                if os.path.exists(arq):
                    html = open(arq, encoding="utf-8", errors="replace").read()
                else:
                    html = buscar(cod, ano, mes)
                    if html:
                        open(arq, "w", encoding="utf-8").write(html)
                    time.sleep(1)
                if not html:
                    print(f"FALHOU {cod} {ano}-{mes:02d}", flush=True)
                    continue
                time.sleep(2)  # gentil com o servidor da ABC
                cats, vals = extrair_chuva(html)
                base = periodo_base(html)
                if not cats or base is None:
                    print(f"SEM-DADOS {cod} {ano}-{mes:02d}", flush=True)
                    continue
                y0, m0, d0 = base
                import datetime as dt
                ini = dt.date(y0, m0, d0)
                for i, v in enumerate(vals):
                    dia = ini + dt.timedelta(days=i)
                    if v is None:
                        continue  # sem leitura (estação offline)
                    try:
                        mm = float(v)
                    except (TypeError, ValueError):
                        continue
                    w.writerow([cod, nome, dia.isoformat(), mm])
                    n += 1
                print(f"ok {cod} {ano}-{mes:02d}: {len(vals)}d", flush=True)
    print(f"TOTAL {n} registros -> {saida}")


if __name__ == "__main__":
    main()
