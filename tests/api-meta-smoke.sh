#!/bin/bash
# v0-compatible API gateway (Phase 3) smoke test: mcp-servers CRUD, webhooks
# CRUD at /hooks, preview-hosts settings, webhook delivery to a local receiver,
# and chat-scoped webhook filtering.
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

API_PORT=9989
RECV_PORT=$((API_PORT + 1))
PREVIEW_PORT=$((API_PORT + 2))
BASE="http://127.0.0.1:${API_PORT}/v2"
API=""
RECV=""

cleanup() {
  [ -n "$API" ] && kill "$API" 2>/dev/null
  [ -n "$RECV" ] && kill "$RECV" 2>/dev/null
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

# local webhook receiver: appends "<event>\t<scopeId>" per POST
node -e '
const http = require("http")
const fs = require("fs")
const port = Number(process.argv[1])
const out = process.argv[2]
http.createServer((req, res) => {
  let body = ""
  req.on("data", (c) => { body += c })
  req.on("end", () => {
    try {
      const p = JSON.parse(body)
      fs.appendFileSync(out, `${p.event}\t${req.url}\t${(p.data && (p.data.chatId || p.data.id)) || ""}\n`)
    } catch {}
    res.writeHead(200, { "Content-Type": "application/json" })
    res.end("{}")
  })
}).listen(port, "127.0.0.1")
' "$RECV_PORT" "$TMP/received.log" &
RECV=$!
sleep 1

start_api

# --- mcp-servers CRUD -------------------------------------------------------
MCP=$(curl -s -X POST -H 'Content-Type: application/json' -d '{"name":"mcp-a","url":"http://127.0.0.1:1","description":"d","auth":{"type":"bearer","token":"x"},"scope":"user"}' "$BASE/mcp-servers")
MCP_ID=$(echo "$MCP" | J "d['id']")
check "mcpServers.create returns an id" [ "${MCP_ID#mcp_}" != "$MCP_ID" ]
check "mcpServers.create persists auth" \
  sh -c "echo '$MCP' | grep -q '\"type\":\"bearer\"'"

check "mcpServers.list returns the server" \
  sh -c "curl -s '$BASE/mcp-servers' | grep -q '$MCP_ID'"
check "mcpServers.get returns the server" \
  [ "$(curl -s "$BASE/mcp-servers/$MCP_ID" | J "d['id']")" = "$MCP_ID" ]
check "mcpServers.get unknown -> 404" \
  [ "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/mcp-servers/mcp_nope")" = "404" ]
check "mcpServers.update flips enabled" \
  sh -c "curl -s -X PATCH -H 'Content-Type: application/json' -d '{\"enabled\":false}' '$BASE/mcp-servers/$MCP_ID' | grep -q '\"enabled\":false'"
check "mcpServers.delete returns {success:true}" \
  [ "$(curl -s -X DELETE "$BASE/mcp-servers/$MCP_ID" | J "d['success']")" = "True" ]
check "mcpServers.delete unknown -> 404" \
  [ "$(curl -s -o /dev/null -w '%{http_code}' -X DELETE "$BASE/mcp-servers/mcp_nope")" = "404" ]
check "mcpServers.create without url -> 422" \
  [ "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d '{"name":"n"}' "$BASE/mcp-servers")" = "422" ]

# --- webhooks CRUD ----------------------------------------------------------
HOOK=$(curl -s -X POST -H 'Content-Type: application/json' -d '{"name":"deliver","events":["chat.created","message.finished"],"url":"http://127.0.0.1:'$RECV_PORT'/hook"}' "$BASE/hooks")
HOOK_ID=$(echo "$HOOK" | J "d['id']")
check "webhooks.create returns an id" [ "${HOOK_ID#hook_}" != "$HOOK_ID" ]
check "webhooks.create returns the Webhook shape" \
  sh -c "echo '$HOOK' | grep -q '\"events\":\[.*chat.created'"

check "webhooks.list returns the hook" \
  sh -c "curl -s '$BASE/hooks' | grep -q '$HOOK_ID'"
check "webhooks.get returns the hook" \
  [ "$(curl -s "$BASE/hooks/$HOOK_ID" | J "d['id']")" = "$HOOK_ID" ]
check "webhooks.get unknown -> 404" \
  [ "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/hooks/hook_nope")" = "404" ]
check "webhooks.update renames the hook" \
  [ "$(curl -s -X PATCH -H 'Content-Type: application/json' -d '{"name":"renamed"}' "$BASE/hooks/$HOOK_ID" | J "d['name']")" = "renamed" ]
check "webhooks.create rejects unknown events -> 422" \
  [ "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d '{"name":"n","events":["bogus.event"],"url":"http://127.0.0.1:1"}' "$BASE/hooks")" = "422" ]
check "webhooks.update rejects unknown events -> 422" \
  [ "$(curl -s -o /dev/null -w '%{http_code}' -X PATCH -H 'Content-Type: application/json' -d '{"events":["bogus.event"]}' "$BASE/hooks/$HOOK_ID")" = "422" ]
check "webhooks.create without events -> 422" \
  [ "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d '{"name":"n","url":"http://127.0.0.1:1"}' "$BASE/hooks")" = "422" ]

# --- webhook delivery -------------------------------------------------------
CID=$(curl -s -X POST -H 'Content-Type: application/json' -d '{"message":"hello"}' "$BASE/chats" | J "d['chat']['id']")
sleep 1
check "chat.created delivered to receiver" \
  sh -c "grep -q '^chat.created' '$TMP/received.log'"
check "webhook-deliveries.jsonl records the delivery" \
  sh -c "grep -q '\"state\":\"delivered\"' '$TMP/api/webhook-deliveries.jsonl'"

# chat-scoped hook: only fires for its chat
SCOPE=$(curl -s -X POST -H 'Content-Type: application/json' -d '{"name":"scoped","events":["message.finished"],"url":"http://127.0.0.1:'$RECV_PORT'/scoped","chatId":"'$CID'"}' "$BASE/hooks")
check "webhooks.create accepts chatId scope" \
  sh -c "echo '$SCOPE' | grep -q '\"chatId\":\"$CID\"'"
curl -s -X POST -H 'Content-Type: application/json' -d '{"message":"footer"}' "$BASE/chats/$CID/messages" >/dev/null
sleep 1
check "scoped webhook fires for its chat's message" \
  sh -c "grep -q '/scoped' '$TMP/received.log'"
OTHER=$(curl -s -X POST -H 'Content-Type: application/json' -d '{"message":"other chat"}' "$BASE/chats" | J "d['chat']['id']")
curl -s -X POST -H 'Content-Type: application/json' -d '{"message":"hi"}' "$BASE/chats/$OTHER/messages" >/dev/null
sleep 1
check "scoped webhook does not fire for another chat" \
  sh -c "[ \"\$(grep -c '/scoped' '$TMP/received.log')\" = 1 ]"

# --- preview-hosts settings -------------------------------------------------
check "settings.getPreviewHosts returns empty by default" \
  sh -c "curl -s '$BASE/settings/preview-hosts' | grep -q '\"hosts\":\[\]'"
check "settings.setPreviewHosts stores hosts" \
  sh -c "curl -s -X PUT -H 'Content-Type: application/json' -d '{\"hosts\":[\"*.example.com\",\"app.local\"]}' '$BASE/settings/preview-hosts' | grep -q '\"*.example.com\"'"
check "settings.getPreviewHosts returns stored hosts" \
  sh -c "curl -s '$BASE/settings/preview-hosts' | grep -q 'app.local'"

# --- webhook delete ---------------------------------------------------------
check "webhooks.delete returns {id,deleted:true}" \
  [ "$(curl -s -X DELETE "$BASE/hooks/$HOOK_ID" | J "d['deleted']")" = "True" ]
check "webhooks.delete unknown -> 404" \
  [ "$(curl -s -o /dev/null -w '%{http_code}' -X DELETE "$BASE/hooks/hook_nope")" = "404" ]

# --- persistence across restart --------------------------------------------
curl -s -X POST -H 'Content-Type: application/json' -d '{"name":"mcp-b","url":"http://127.0.0.1:2"}' "$BASE/mcp-servers" >/dev/null
kill "$API" 2>/dev/null
wait "$API" 2>/dev/null
API=""
start_api

check "mcp-servers and hooks survive a restart (persisted state)" \
  sh -c "curl -s '$BASE/mcp-servers' | grep -q 'mcp-b' && curl -s '$BASE/hooks' | grep -q 'scoped'"

if [ "$FAIL" -eq 0 ]; then
  echo "api-meta-smoke: PASS"
else
  echo "api-meta-smoke: FAIL"
  exit 1
fi
