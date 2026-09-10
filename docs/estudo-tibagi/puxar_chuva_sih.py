#!/usr/bin/env python3
"""Chuva diária IAT/SIH (relatório alturas diárias, 2 leituras/dia 7h+17h).

Uso: python3 puxar_chuva_sih.py
Saída: chuva-sih.csv (estacao_id,data,mm_total_dia) + raws em raw-chuva/
Estações IAT confirmadas com série: ITAIACOCA, APIABA, BOCAINA.
"""
import csv
import os
import re
import sys
import time
import urllib.parse
import urllib.request
import http.cookiejar

BASE = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(BASE, "raw-chuva")
os.makedirs(RAW, exist_ok=True)

ESTACOES = {
    "2549052": "ITAIACOCA",
    "2550043": "APIABA",
    "2450021": "BOCAINA",
}

ANOS = list(range(2011, 2027))

URL = ("http://www.sih-web.aguasparana.pr.gov.br/sih-web/"
       "gerarRelatorioAlturasDiariasPrecipitacao.do?action=gerarRelatorio")


def op_com_cookies():
    cj = http.cookiejar.MozillaCookieJar("/tmp/sih_jar3.txt")
    try:
        cj.load(ignore_discard=True, ignore_expires=True)
    except FileNotFoundError:
        pass
    return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))


def buscar(op, cod, nome, ano):
    params = {
        "codEstacao": cod, "nomeEstacao": nome, "codMunicipio": "",
        "anoInicial": str(ano), "anoFinal": str(ano), "anoAtual": "2026",
        "leituraCadastrada": "true", "formato": "TXT",
    }
    req = urllib.request.Request(
        URL, data=urllib.parse.urlencode(params).encode(),
        headers={"User-Agent": "Mozilla/5.0"},
    )
    for tentativa in range(3):
        try:
            with op.open(req, timeout=120) as r:
                return r.read().decode("iso-8859-1", errors="replace")
        except Exception:
            time.sleep(3 + tentativa * 3)
    return ""


def extrair_diaria(html):
    """{date: mm} somando 7h+17h; ignora linhas sem leitura."""
    import datetime as dt
    dados = {}
    for m in re.finditer(
        r"0?(\d+)\s+(\d{4})\s+(\d{2})\s+(\d{2})\s+(\d{2})\s+(\d{2})\s+([\d,]+)",
        html,
    ):
        try:
            dia = dt.date(int(m.group(2)), int(m.group(3)), int(m.group(4)))
        except ValueError:
            continue
        try:
            mm = float(m.group(7).replace(",", "."))
        except ValueError:
            continue
        dados[dia] = dados.get(dia, 0.0) + mm
    return dados


def main():
    op = op_com_cookies()
    saida = os.path.join(BASE, "chuva-sih.csv")
    n = 0
    with open(saida, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["estacao_id", "estacao_nome", "data", "mm"])
        for cod, nome in ESTACOES.items():
            for ano in ANOS:
                arq = os.path.join(RAW, f"{cod}_{ano}.txt")
                if os.path.exists(arq):
                    html = open(arq, encoding="utf-8", errors="replace").read()
                else:
                    html = buscar(op, cod, nome, ano)
                    if html:
                        open(arq, "w", encoding="utf-8").write(html)
                    time.sleep(2)  # gentil com o SIH
                if not html or "Nenhum registro" in html:
                    print(f"SEM-DADOS {cod} {ano}", flush=True)
                    continue
                dados = extrair_diaria(html)
                if not dados:
                    print(f"VAZIO {cod} {ano}", flush=True)
                    continue
                for dia in sorted(dados):
                    w.writerow([cod, nome, dia.isoformat(), round(dados[dia], 1)])
                    n += 1
                print(f"ok {cod} {ano}: {len(dados)}d", flush=True)
    print(f"TOTAL {n} registros -> {saida}")


if __name__ == "__main__":
    main()
