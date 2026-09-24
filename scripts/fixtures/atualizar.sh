#!/usr/bin/env bash
# Recaptura os fixtures do preview local a partir da produção.
# Uso: bash scripts/fixtures/atualizar.sh
set -euo pipefail
cd "$(dirname "$0")"
BASE="${BASE:-https://servicos-status.vercel.app}"
for rota in services weather; do
  curl -s --max-time 30 "$BASE/api/$rota" -o "$rota.json"
  printf '%-10s %s B\n' "$rota" "$(wc -c < "$rota.json")"
done
curl -s --max-time 30 "$BASE/api/stats/daily" -o stats.json
printf '%-10s %s B\n' stats "$(wc -c < stats.json)"
