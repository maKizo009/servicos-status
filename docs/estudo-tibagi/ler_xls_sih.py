"""Leitor determinístico do XLS do SIH (matriz ano × dia × mês).

Layout: bloco por ano — linha [AAAA, ...], linha [DIA, JAN..DEZ],
linhas [dia, jan..dez]. Retorna {date: nivel_cm}, ignorando células
vazias/não-numéricas. Sem inferência, sem interpolação.
"""

MESES = ["JAN", "FEV", "MAR", "ABR", "MAI", "JUN", "JUL", "AGO", "SET", "OUT", "NOV", "DEZ"]


def ler_xls_sih(caminho):
    import xlrd
    from datetime import date

    wb = xlrd.open_workbook(caminho)
    sh = wb.sheet_by_index(0)
    grade = [[sh.cell_value(r, c) for c in range(sh.ncols)] for r in range(sh.nrows)]
    dados = {}
    ano = None
    mapa_mes = None
    for row in grade:
        txt = [str(v).strip().upper() for v in row]
        if len(txt) > 1 and txt[1] == "DIA" and set(MESES).issubset(set(txt)):
            mapa_mes = {m: txt.index(m) for m in MESES}
            continue
        if (
            len(row) > 0
            and isinstance(row[0], float)
            and 1900 < int(row[0]) < 2100
            and not isinstance(row[1], float)
        ):
            ano = int(row[0])
            continue
        if ano is not None and mapa_mes is not None and isinstance(row[1], float):
            dia = int(row[1])
            if not 1 <= dia <= 31:
                continue
            for i, m in enumerate(MESES, start=1):
                v = row[mapa_mes[m]]
                if isinstance(v, float) and v > 0:
                    try:
                        dados[date(ano, i, dia)] = int(v)
                    except ValueError:
                        pass
        if len(row) > 0 and isinstance(row[0], float) and 1900 < int(row[0]) < 2100 and mapa_mes is not None:
            pass  # ano seguinte reutiliza o mapa de meses
    return dados


if __name__ == "__main__":
    import sys
    d = ler_xls_sih(sys.argv[1])
    print(len(d), "leituras", min(d), "->", max(d))
