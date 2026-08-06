#!/bin/bash
# Metrics smoke test: --once posts a metrics_report to a local callback server,
# and the no-callback path exits cleanly.
set -u

NEXOS_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
FAIL=0

check() {
  local desc="$1"; shift
  if "$@"; then
    echo "ok: $desc"
  else
    echo "FAIL: $desc"
    FAIL=1
  fi
}

# --- case 1: with callback -------------------------------------------------
PORT=7699
RECORDED="$TMP/recorded.json"

node -e "
  const http = require('http');
  const fs = require('fs');
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      fs.writeFileSync('$RECORDED', body);
      res.writeHead(200); res.end('ok');
      server.close();
    });
  });
  server.listen($PORT, '127.0.0.1');
" &
CBSERVER=$!
sleep 0.5

cat >"$TMP/nexos.env" <<EOF
NEXOS_CALLBACK_URL='http://127.0.0.1:${PORT}'
NEXOS_CALLBACK_TOKEN='test-token'
NEXOS_CALLBACK_DEPLOYMENT_TARGET='test-target'
EOF

NEXOS_ENV_FILE="$TMP/nexos.env" bash "$NEXOS_ROOT/lib/metrics.sh" --once
wait "$CBSERVER" 2>/dev/null

check "metrics payload recorded" [ -s "$RECORDED" ]
if [ -s "$RECORDED" ]; then
  node -e "
    const p = JSON.parse(require('fs').readFileSync('$RECORDED', 'utf8'));
    const m = p.metrics || {};
    const ok = p.type === 'metrics_report'
      && typeof m.memTotalMB === 'number'
      && typeof m.memUsedPercent === 'number'
      && typeof m.cpuUsagePercent === 'number'
      && typeof m.diskUsedPercent === 'number'
      && typeof m.loadAvg1m === 'number';
    if (!ok) { console.log(JSON.stringify(p)); process.exit(1); }
    console.log('ok: metrics payload shape');
  " || FAIL=1
fi

# --- case 2: no callback configured ----------------------------------------
: >"$TMP/empty.env"
if NEXOS_ENV_FILE="$TMP/empty.env" bash "$NEXOS_ROOT/lib/metrics.sh" --once; then
  echo "ok: no-callback path exits cleanly"
else
  echo "FAIL: no-callback path exited non-zero"
  FAIL=1
fi

# --- case 3: per-service callback fallback ----------------------------------
PORT2=7700
RECORDED2="$TMP/recorded2.json"

node -e "
  const http = require('http');
  const fs = require('fs');
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      fs.writeFileSync('$RECORDED2', body);
      res.writeHead(200); res.end('ok');
      server.close();
    });
  });
  server.listen($PORT2, '127.0.0.1');
" &
CBSERVER2=$!
sleep 0.5

cat >"$TMP/per-service.env" <<EOF
NEXOS_CODE_SERVER_CALLBACK_URL='http://127.0.0.1:${PORT2}'
NEXOS_CODE_SERVER_CALLBACK_TOKEN='svc-token'
NEXOS_CALLBACK_DEPLOYMENT_TARGET='per-svc'
EOF

NEXOS_ENV_FILE="$TMP/per-service.env" bash "$NEXOS_ROOT/lib/metrics.sh" --once
wait "$CBSERVER2" 2>/dev/null

check "per-service callback URL honored" [ -s "$RECORDED2" ]
if [ -s "$RECORDED2" ]; then
  node -e "
    const p = JSON.parse(require('fs').readFileSync('$RECORDED2', 'utf8'));
    const m = p.metrics || {};
    const ok = p.type === 'metrics_report'
      && typeof m.memTotalMB === 'number'
      && typeof m.cpuUsagePercent === 'number';
    if (!ok) process.exit(1);
  " || { echo "FAIL: per-service payload shape"; FAIL=1; }
fi

rm -rf "$TMP"

if [ "$FAIL" -eq 0 ]; then
  echo "metrics-smoke: PASS"
else
  echo "metrics-smoke: FAIL"
  exit 1
fi
