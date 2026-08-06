#!/bin/bash
# Web platform portal smoke test: health, dashboard serving, supervisor status,
# log-history + exec round-trips through a real log-proxy, metrics snapshot,
# settings persistence across restart, and token/session auth for remote clients.
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

LOGPROXY_PORT=9988
WEB_PORT=9989
BASE="http://127.0.0.1:${WEB_PORT}"
TOKEN="web-secret-${WEB_PORT}"
STATE_FILE="$TMP/web-state.json"

# --- real log-proxy backend for proxy round-trips ---------------------------
export NEXOS_LOG_PROXY_PORT="$LOGPROXY_PORT"
export NEXOS_RUN_DIR="$TMP/run"
node "$NEXOS_ROOT/lib/log-proxy.js" >"$TMP/logproxy.log" 2>&1 &
LOGPROXY=$!
sleep 1

start_web() {
  NEXOS_WEB_PORT="$WEB_PORT" NEXOS_WEB_TOKEN="$TOKEN" \
    NEXOS_WEB_STATE_FILE="$STATE_FILE" NEXOS_LOG_PROXY_PORT="$LOGPROXY_PORT" \
    NEXOS_RUN_DIR="$TMP/run" \
    node "$NEXOS_ROOT/web/api-server.js" >"$TMP/web.log" 2>&1 &
  WEB=$!
  sleep 1
}

start_web

# --- health + dashboard ------------------------------------------------------
HEALTH=$(curl -s "$BASE/health")
check "GET /health returns ok" sh -c "echo '$HEALTH' | grep -q '\"status\":\"ok\"'"
check "GET /health reports auth on" sh -c "echo '$HEALTH' | grep -q '\"auth\":true'"
check "GET /health reports logProxy up" sh -c "echo '$HEALTH' | grep -q '\"logProxy\":\"up\"'"
check "GET / serves the dashboard" \
  [ "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/")" = "200" ]
check "GET / returns text/html" \
  sh -c "curl -s -o /dev/null -w '%{content_type}' '$BASE/' | grep -q 'text/html'"

# --- API surface -------------------------------------------------------------
check "GET /api/v1/status returns supervisor array" \
  sh -c "curl -s '$BASE/api/v1/status' | grep -q '\"supervisor\":'"
check "GET /api/v1/logs proxies empty history" \
  sh -c "curl -s '$BASE/api/v1/logs' | grep -q '\"logs\":\['"
check "POST /api/v1/exec round-trips through log-proxy" \
  sh -c "curl -s -X POST -H 'Content-Type: application/json' -d '{\"cmd\":\"echo\",\"args\":[\"web-smoke\"],\"wait\":true}' '$BASE/api/v1/exec' | grep -q '\"exitCode\":0'"
check "GET /api/v1/metrics reports memory" \
  sh -c "curl -s '$BASE/api/v1/metrics' | grep -q '\"memTotalMB\":[1-9]'"
check "GET /api/v1/git-sign reports unreachable when down" \
  sh -c "curl -s '$BASE/api/v1/git-sign' | grep -q '\"reachable\":false'"
check "unknown route returns 404" \
  [ "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/v1/nope")" = "404" ]

# --- settings persistence ----------------------------------------------------
check "PUT /api/v1/settings accepted" \
  curl -fs -o /dev/null -X PUT -H 'Content-Type: application/json' \
  -d '{"settings":{"logInterval":7}}' "$BASE/api/v1/settings"
check "GET /api/v1/settings returns saved value" \
  sh -c "curl -s '$BASE/api/v1/settings' | grep -q '\"logInterval\":7'"

# --- restart restores persisted settings ------------------------------------
kill "$WEB" 2>/dev/null
wait "$WEB" 2>/dev/null
start_web
check "settings survive a web-server restart" \
  sh -c "curl -s '$BASE/api/v1/settings' | grep -q '\"logInterval\":7'"

kill "$WEB" 2>/dev/null
wait "$WEB" 2>/dev/null

# --- remote reachability + auth ---------------------------------------------
REMOTE_IP=$(ip -4 -o addr show scope global 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | head -1)
if [ -n "$REMOTE_IP" ]; then
  WEB_PORT2=$((WEB_PORT + 1))
  NEXOS_WEB_PORT="$WEB_PORT2" NEXOS_WEB_TOKEN="$TOKEN" \
    NEXOS_WEB_STATE_FILE="$STATE_FILE" NEXOS_LOG_PROXY_PORT="$LOGPROXY_PORT" \
    NEXOS_RUN_DIR="$TMP/run" NEXOS_ALLOW_REMOTE=true \
    node "$NEXOS_ROOT/web/api-server.js" >"$TMP/web-remote.log" 2>&1 &
  WEB2=$!
  sleep 1
  RBASE="http://$REMOTE_IP:$WEB_PORT2"

  check "remote without token gets 401" \
    [ "$(curl -s -o /dev/null -w '%{http_code}' -m 2 "$RBASE/api/v1/status" 2>/dev/null)" = "401" ]
  check "remote with wrong token gets 401" \
    [ "$(curl -s -o /dev/null -w '%{http_code}' -m 2 -H "Authorization: Bearer nope" "$RBASE/api/v1/status" 2>/dev/null)" = "401" ]
  check "remote with valid bearer is served" \
    [ "$(curl -s -o /dev/null -w '%{http_code}' -m 2 -H "Authorization: Bearer $TOKEN" "$RBASE/api/v1/status" 2>/dev/null)" = "200" ]
  check "loopback needs no token even when configured" \
    [ "$(curl -s -o /dev/null -w '%{http_code}' -m 2 "http://127.0.0.1:$WEB_PORT2/api/v1/status" 2>/dev/null)" = "200" ]

  # login issues a session cookie usable for remote requests
  check "login with valid token issues session cookie" \
    [ "$(curl -s -o /dev/null -w '%{http_code}' -m 2 -c "$TMP/cookies.txt" -X POST -H 'Content-Type: application/json' -d "{\"token\":\"$TOKEN\"}" "$RBASE/api/v1/login" 2>/dev/null)" = "200" ]
  check "session cookie authorizes remote requests" \
    [ "$(curl -s -o /dev/null -w '%{http_code}' -m 2 -b "$TMP/cookies.txt" "$RBASE/api/v1/status" 2>/dev/null)" = "200" ]
  check "login with wrong token rejected" \
    [ "$(curl -s -o /dev/null -w '%{http_code}' -m 2 -X POST -H 'Content-Type: application/json' -d '{"token":"wrong"}' "$RBASE/api/v1/login" 2>/dev/null)" = "401" ]

  kill "$WEB2" 2>/dev/null
  wait "$WEB2" 2>/dev/null
else
  echo "skipped: no non-loopback interface for remote-reachability check"
fi

kill "$LOGPROXY" 2>/dev/null
wait "$LOGPROXY" 2>/dev/null

rm -rf "$TMP"

if [ "$FAIL" -eq 0 ]; then
  echo "web-smoke: PASS"
else
  echo "web-smoke: FAIL"
  exit 1
fi
