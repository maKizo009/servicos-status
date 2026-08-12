#!/usr/bin/env bash
set -euo pipefail

HOST="${MONITOR_HOST:-http://127.0.0.1:3030}"
LOG_DIR="${MONITOR_LOG_DIR:-/var/log/services-monitor}"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/$(date +%Y-%m-%d).log"

log()  { echo "[$(date '+%H:%M:%S')] $*" | tee -a "$LOG"; }
error(){ log "ERRO: $*"; }

# 1. Health check basico
log "=== Verificacao $(date '+%d/%m/%Y %H:%M') ==="

HTTP=$(curl -s -o /dev/null -w "%{http_code}" "$HOST/health" 2>/dev/null || echo "000")
if [ "$HTTP" != "200" ]; then
  error "Health endpoint retornou $HTTP"
  error "Tentando reiniciar container..."
  docker restart services-health-monitor 2>/dev/null || error "Falha ao reiniciar container"
  exit 1
fi
log "Health: OK ($HTTP)"

# 2. Verificar status da API
API=$(curl -s "$HOST/api/status" 2>/dev/null || echo '{"level":"error"}')
LEVEL=$(echo "$API" | python3 -c "import sys,json; print(json.load(sys.stdin).get('level','unknown'))" 2>/dev/null || echo "unknown")

if [ "$LEVEL" = "error" ] || [ "$LEVEL" = "unknown" ]; then
  error "API /api/status retornou level=$LEVEL"
  exit 1
fi
log "Status geral: $LEVEL"

# 3. Verificar se os dados sao recentes (ultimos 5 min)
TIMESTAMP=$(echo "$API" | python3 -c "import sys,json; print(json.load(sys.stdin).get('timestamp',0))" 2>/dev/null || echo "0")
NOW=$(date +%s%3N)
AGE=$(( (NOW - TIMESTAMP) / 1000 ))

if [ "$AGE" -gt 300 ]; then
  error "Dados desatualizados: $AGE segundos atras"
else
  log "Dados atualizados: ${AGE}s atras"
fi

# 4. Log detalhado dos operadores
echo "$API" | python3 -c "
import sys, json
data = json.load(sys.stdin)
print('  Operadores:')
for op in data.get('operators', []):
    print(f'    {op[\"operator\"]}: {op.get(\"status\",\"?\")}')
    for c in op.get('connectivity', []):
        lat = f'{c.get(\"latencyMs\",\"?\")}ms'
        st = 'OK' if c.get('success') else 'FALHA'
        print(f'      Conectividade {c.get(\"host\",\"?\")}: {st} ({lat})')
    bgp = op.get('bgp')
    if bgp:
        print(f'      BGP AS{bgp.get(\"asn\",\"?\")}: {bgp.get(\"prefixCountV4\",0)} v4 / {bgp.get(\"prefixCountV6\",0)} v6 prefixos')
" 2>&1 | tee -a "$LOG"

# 5. Verificar logs recentes do container para erros
docker logs --since 30m services-health-monitor 2>&1 | grep -iE '(error|critical|fail|warn)' | head -20 | while read line; do
  log "  [LOG] $line"
done

log "Monitoramento concluido"
echo "" >> "$LOG"
