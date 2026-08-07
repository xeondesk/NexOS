#!/bin/bash
# v0-compatible API gateway (Phase 0) smoke test: health, auto-derived route
# table (all 41 v2 operations registered from openapi-v2.json), contract
# validation (422), error shape {message}, 404 behavior, and bearer/loopback
# auth for remote clients.
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

API_PORT=9986
BASE="http://127.0.0.1:${API_PORT}"
TOKEN="api-secret-${API_PORT}"

start_api() {
  NEXOS_API_PORT="$API_PORT" NEXOS_API_TOKEN="$TOKEN" \
    NEXOS_API_STATE_DIR="$TMP/api" \
    node "$NEXOS_ROOT/api/api-server.mjs" >"$TMP/api.log" 2>&1 &
  API=$!
  sleep 1
}

start_api

# --- health -------------------------------------------------------------------
HEALTH=$(curl -s "$BASE/health")
check "GET /health returns ok" sh -c "echo '$HEALTH' | grep -q '\"status\":\"ok\"'"
check "GET /health reports auth on" sh -c "echo '$HEALTH' | grep -q '\"auth\":true'"
check "GET /health derives all 41 operations" sh -c "echo '$HEALTH' | grep -q '\"operations\":41'"
check "GET /health reports /v2 base" sh -c "echo '$HEALTH' | grep -q '\"base\":\"/v2\"'"

# --- routing (operations registered, not yet implemented) ---------------------
check "POST /v2/chats routes to chats.create (501)" \
  [ "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d '{"message":"hi"}' "$BASE/v2/chats")" = "501" ]
check "chats.create 501 carries Error shape" \
  sh -c "curl -s -X POST -H 'Content-Type: application/json' -d '{\"message\":\"hi\"}' '$BASE/v2/chats' | grep -q '\"message\":\"not_implemented:chats.create\"'"
check "GET /v2/chats routes to chats.list (501)" \
  [ "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/v2/chats")" = "501" ]
check "GET /v2/chats/{id} routes to chats.get (501)" \
  [ "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/v2/chats/chat_abc")" = "501" ]
check "deep param route messages.stop matches (501)" \
  [ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/v2/chats/chat_abc/messages/msg_1/stop")" = "501" ]
check "POST /v2/chats/stream routes to chats.createStream (501)" \
  [ "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d '{"message":"hi"}' "$BASE/v2/chats/stream")" = "501" ]
check "GET /v2/chats/{id}/preview routes to chats.getPreview (501)" \
  [ "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/v2/chats/chat_abc/preview")" = "501" ]
check "GET /v2/mcp-servers routes to mcpServers.list (501)" \
  [ "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/v2/mcp-servers")" = "501" ]

# --- contract validation ------------------------------------------------------
check "chats.create without message -> 422" \
  [ "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d '{}' "$BASE/v2/chats")" = "422" ]
check "422 carries Error shape" \
  sh -c "curl -s -X POST -H 'Content-Type: application/json' -d '{}' '$BASE/v2/chats' | grep -q '\"message\":\"message is required\"'"
check "createFromRepo without repo.url -> 422" \
  sh -c "curl -s -X POST -H 'Content-Type: application/json' -d '{\"repo\":{}}' '$BASE/v2/chats/from-repo' | grep -q 'repo.url is required'"
check "malformed JSON -> 400" \
  [ "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d '{nope' "$BASE/v2/chats")" = "400" ]

# --- 404 behavior -------------------------------------------------------------
check "unknown v2 route returns 404" \
  [ "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/v2/nonexistent")" = "404" ]
check "method not in contract for path returns 404" \
  [ "$(curl -s -o /dev/null -w '%{http_code}' -X PUT "$BASE/v2/chats")" = "404" ]
check "non-v2 path returns 404" \
  [ "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/v1/nope")" = "404" ]

# --- auth: loopback trusted, remote needs bearer ------------------------------
kill "$API" 2>/dev/null
wait "$API" 2>/dev/null

REMOTE_IP=$(ip -4 -o addr show scope global 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | head -1)
if [ -n "$REMOTE_IP" ]; then
  API_PORT2=$((API_PORT + 1))
  NEXOS_API_PORT="$API_PORT2" NEXOS_API_TOKEN="$TOKEN" NEXOS_ALLOW_REMOTE=true \
    NEXOS_API_STATE_DIR="$TMP/api" \
    node "$NEXOS_ROOT/api/api-server.mjs" >"$TMP/api-remote.log" 2>&1 &
  API2=$!
  sleep 1
  RBASE="http://$REMOTE_IP:$API_PORT2"

  check "remote without token gets 401" \
    [ "$(curl -s -o /dev/null -w '%{http_code}' -m 2 "$RBASE/v2/chats" 2>/dev/null)" = "401" ]
  check "remote with wrong token gets 401" \
    [ "$(curl -s -o /dev/null -w '%{http_code}' -m 2 -H "Authorization: Bearer nope" "$RBASE/v2/chats" 2>/dev/null)" = "401" ]
  check "remote with valid bearer is served" \
    [ "$(curl -s -o /dev/null -w '%{http_code}' -m 2 -H "Authorization: Bearer $TOKEN" "$RBASE/v2/chats" 2>/dev/null)" = "501" ]
  check "loopback needs no token even when configured" \
    [ "$(curl -s -o /dev/null -w '%{http_code}' -m 2 "http://127.0.0.1:$API_PORT2/v2/chats" 2>/dev/null)" = "501" ]
  check "401 carries Error shape" \
    sh -c "curl -s -m 2 '$RBASE/v2/chats' 2>/dev/null | grep -q '\"message\":\"Unauthorized\"'"

  kill "$API2" 2>/dev/null
  wait "$API2" 2>/dev/null
else
  echo "skipped: no non-loopback interface for remote-reachability check"
fi

kill "$API" 2>/dev/null
wait "$API" 2>/dev/null

rm -rf "$TMP"
if [ "$FAIL" -eq 0 ]; then
  echo "api-smoke: PASS"
else
  echo "api-smoke: FAIL"
  exit 1
fi
