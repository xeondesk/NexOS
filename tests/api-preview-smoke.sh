#!/bin/bash
# v0-compatible API gateway (Phase 3) smoke test: chats.getPreview + the preview
# ingress (signed token via header/query, mock-upstream forwarding, refresh
# fallback, 403/404 paths).
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

API_PORT=9992
PREVIEW_PORT=$((API_PORT + 1))
BASE="http://127.0.0.1:${API_PORT}/v2"
PV="http://127.0.0.1:${PREVIEW_PORT}"
API=""

cleanup() {
  [ -n "$API" ] && kill "$API" 2>/dev/null
  wait 2>/dev/null
  rm -rf "$TMP"
}
trap cleanup EXIT

J() { python3 -c "import json,sys; d=json.load(sys.stdin); print(eval(sys.argv[1]))" "$1"; }

start_api() {
  NEXOS_API_PORT="$API_PORT" NEXOS_PREVIEW_PORT="$PREVIEW_PORT" NEXOS_API_STATE_DIR="$TMP/api" \
    node "$NEXOS_ROOT/api/api-server.mjs" >"$TMP/api.log" 2>&1 &
  API=$!
  sleep 1
}

start_api

# chat without files: preview is null
CID=$(curl -s -X POST -H 'Content-Type: application/json' -d '{"message":"no files"}' "$BASE/chats" | J "d['chat']['id']")
check "chats.getPreview is null until files exist" \
  [ "$(curl -s "$BASE/chats/$CID/preview")" = "null" ]
check "chats.getPreview unknown chat -> 404" \
  [ "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/chats/chat_nope/preview")" = "404" ]

# chat with files: signed preview URL + token
FF=$(curl -s -X POST -H 'Content-Type: application/json' -d '{"files":[{"path":"index.html","content":"<h1>hi</h1>","encoding":"utf8"},{"path":"app.js","content":"console.log(1)","encoding":"utf8"}],"title":"Preview me"}' "$BASE/chats/from-files")
FF_ID=$(echo "$FF" | J "d['chat']['id']")
PVJ=$(curl -s "$BASE/chats/$FF_ID/preview")
check "chats.getPreview returns a preview object" \
  sh -c "echo '$PVJ' | grep -q '\"url\":' && echo '$PVJ' | grep -q '\"token\":' && echo '$PVJ' | grep -q '\"expiresAt\":'"
PV_URL=$(echo "$PVJ" | J "d['url']")
PV_TOKEN=$(echo "$PVJ" | J "d['token']")
check "preview url points at the chat on the preview ingress" \
  sh -c "case '$PV_URL' in $PV/$FF_ID/) true ;; *) false ;; esac"
check "preview token is non-trivial" [ "${#PV_TOKEN}" -gt 40 ]

# ingress: valid token via header
BODY=$(curl -s -H "x-v0-preview-token: $PV_TOKEN" "${PV_URL}index.html")
check "ingress serves index.html with a valid token header" \
  sh -c "echo '$BODY' | grep -q '<h1>hi</h1>'"
check "ingress pins Cache-Control: private, no-store" \
  sh -c "curl -s -D - -o /dev/null -H \"x-v0-preview-token: $PV_TOKEN\" '${PV_URL}index.html' | grep -qi 'cache-control: private, no-store'"

# ingress: valid token via query
check "ingress serves a file with a valid token query" \
  sh -c "curl -s '${PV_URL}app.js?token=$PV_TOKEN' | grep -q 'console.log(1)'"

# ingress: auth failures
check "ingress rejects a bad token -> 403" \
  [ "$(curl -s -o /dev/null -w '%{http_code}' -H "x-v0-preview-token: bogus" "${PV_URL}index.html")" = "403" ]
check "ingress rejects a missing token -> 403" \
  [ "$(curl -s -o /dev/null -w '%{http_code}' "${PV_URL}index.html")" = "403" ]

# ingress: refresh fallback (mock upstream honors ?__refresh=1)
REFRESH=$(curl -s -o /dev/null -w '%{http_code}|%{redirect_url}' -H "x-v0-preview-token: $PV_TOKEN" "${PV_URL}index.html?__refresh=1")
check "ingress honors x-v0-preview-refresh with a fallback redirect" \
  sh -c "[ '${REFRESH%%|*}' = 302 ] && echo '$REFRESH' | grep -q '/_loading'"

# ingress: root serves the chat index
check "ingress root serves the chat's index.html" \
  sh -c "curl -s -H \"x-v0-preview-token: $PV_TOKEN\" '$PV_URL' | grep -q '<h1>hi</h1>'"

# ingress: unknown chat
check "ingress rejects an unknown chat -> 403" \
  [ "$(curl -s -o /dev/null -w '%{http_code}' -H "x-v0-preview-token: $PV_TOKEN" "$PV/chat_zzz/index.html")" = "403" ]

# ingress: wrong-chat token is rejected
FF2=$(curl -s -X POST -H 'Content-Type: application/json' -d '{"files":[{"path":"a.txt","content":"x","encoding":"utf8"}]}' "$BASE/chats/from-files")
FF2_ID=$(echo "$FF2" | J "d['chat']['id']")
OTHER_TOKEN=$(curl -s "$BASE/chats/$FF2_ID/preview" | J "d['token']")
check "ingress rejects a token minted for another chat -> 403" \
  [ "$(curl -s -o /dev/null -w '%{http_code}' -H "x-v0-preview-token: $OTHER_TOKEN" "${PV_URL}index.html")" = "403" ]

# persisted preview state survives a restart
kill "$API" 2>/dev/null
wait "$API" 2>/dev/null
API=""
start_api

PVJ2=$(curl -s "$BASE/chats/$FF_ID/preview")
check "preview survives a restart (same chat id)" \
  sh -c "echo '$PVJ2' | grep -q '\"token\":'"

if [ "$FAIL" -eq 0 ]; then
  echo "api-preview-smoke: PASS"
else
  echo "api-preview-smoke: FAIL"
  exit 1
fi
