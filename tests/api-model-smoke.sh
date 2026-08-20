#!/bin/bash
# v0-compatible API gateway model-backend smoke test.
#
# Boots the OpenAI-compatible LLM stub (tests/fixtures/llm-stub.mjs) plus the
# gateway with NEXOS_API_MODEL_URL pointing at it, then verifies the streaming
# ops (`chats.createStream`, `messages.sendStream`, and their `/v2/ai/*`
# envelope variants) stream the stub's tokens through the raw/envelope wire
# formats, persist the finished assistant, replay on resume, and roll back on
# a model error. Also asserts the gateway sends the model/auth/messages it was
# configured with (including conversation history on later turns).
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

STUB_PORT=9995
API_PORT=9994
BASE="http://127.0.0.1:${API_PORT}"
STUB=""
API=""

cleanup() {
  [ -n "$STUB" ] && kill "$STUB" 2>/dev/null
  [ -n "$API" ] && kill "$API" 2>/dev/null
  wait 2>/dev/null
  rm -rf "$TMP"
}
trap cleanup EXIT

J() { python3 -c "import json,sys; d=json.load(sys.stdin); print(eval(sys.argv[1]))" "$1"; }

node "$NEXOS_ROOT/tests/fixtures/llm-stub.mjs" "$STUB_PORT" "$TMP/stub.log" >"$TMP/stub.out" 2>&1 &
STUB=$!
sleep 0.5

start_api() {
  NEXOS_API_PORT="$API_PORT" NEXOS_API_STATE_DIR="$TMP/api" \
    NEXOS_API_MODEL_URL="http://127.0.0.1:${STUB_PORT}/v1" \
    NEXOS_API_MODEL_KEY="test-key" \
    NEXOS_API_MODEL="test-model" \
    node "$NEXOS_ROOT/api/api-server.mjs" >"$TMP/api.log" 2>&1 &
  API=$!
  sleep 1
}

stop_api() {
  [ -n "$API" ] && kill "$API" 2>/dev/null
  wait "$API" 2>/dev/null
  API=""
}

start_api

# --- raw chats.createStream ------------------------------------------------
CREATE=$(curl -sN -X POST -H 'Content-Type: application/json' \
  -d '{"message":"build a site"}' "$BASE/v2/chats/stream")
echo "$CREATE" >"$TMP/create.txt"

check "createStream emits chat + chat.title frames" \
  sh -c "grep -q '\"object\":\"chat\"' '$TMP/create.txt' && grep -q '\"object\":\"chat.title\"' '$TMP/create.txt'"
check "createStream emits parts deltas" \
  sh -c "[ \"\$(grep -c '\"object\":\"message.parts.chunk\"' '$TMP/create.txt')\" -ge 2 ]"
check "createStream streams the model tokens" \
  sh -c "grep -q 'Hello' '$TMP/create.txt'"
check "createStream closes with usage + chat" \
  sh -c "grep -q '\"object\":\"message.usage\"' '$TMP/create.txt'"

CID=$(grep -m1 '"object":"chat"' "$TMP/create.txt" | sed 's/^data: //' | J "d['id']")
check "createStream assigns a chat id" [ "${CID#chat_}" != "$CID" ]

check "createStream persists the finished assistant" \
  sh -c "curl -s '$BASE/v2/chats/$CID/messages?limit=10' | grep -q '\"content\":\"Hello\"'"
check "createStream persists finishReason stop + restorable" \
  sh -c "curl -s '$BASE/v2/chats/$CID/messages?limit=10' | grep -q '\"finishReason\":\"stop\"'"

# --- raw messages.sendStream (with conversation history) -------------------
SEND=$(curl -sN -X POST -H 'Content-Type: application/json' \
  -d '{"message":"add a footer"}' "$BASE/v2/chats/$CID/messages/stream")
echo "$SEND" >"$TMP/send.txt"
check "sendStream emits opening message + deltas + usage + closing message" \
  sh -c "grep -q '\"object\":\"message.usage\"' '$TMP/send.txt' && [ \"\$(grep -c '\"object\":\"message.parts.chunk\"' '$TMP/send.txt')\" -ge 2 ]"
check "sendStream streams the model tokens" \
  sh -c "grep -q 'Hello' '$TMP/send.txt'"

# --- envelope variants (v2/ai) --------------------------------------------
ENV=$(curl -sN -X POST -H 'Content-Type: application/json' \
  -d '{"message":"envelope chat"}' "$BASE/v2/ai/chats/stream")
echo "$ENV" >"$TMP/env.txt"
check "envelope createStream emits update + done frames" \
  sh -c "grep -q 'event: update' '$TMP/env.txt' && grep -q 'event: done' '$TMP/env.txt'"
check "envelope createStream carries the streamed text in the snapshot" \
  sh -c "grep -q 'Hello' '$TMP/env.txt'"

ENVSEND=$(curl -sN -X POST -H 'Content-Type: application/json' \
  -d '{"message":"one more"}' "$BASE/v2/ai/chats/$CID/messages/stream")
echo "$ENVSEND" >"$TMP/envsend.txt"
check "envelope sendStream emits update + done frames" \
  sh -c "grep -q 'event: update' '$TMP/envsend.txt' && grep -q 'event: done' '$TMP/envsend.txt'"

# --- resume replays the stored generation ----------------------------------
RESUME=$(curl -sN -X POST -H 'Content-Type: application/json' -d '{}' "$BASE/v2/chats/$CID/resume")
echo "$RESUME" >"$TMP/resume.txt"
check "chats.resume replays the model generation" \
  sh -c "grep -q '\"object\":\"message.usage\"' '$TMP/resume.txt' && grep -q 'Hello' '$TMP/resume.txt'"

# --- stub saw the configured model/auth + conversation history -------------
check "stub received the model name + bearer auth + streaming flag" \
  sh -c "grep -q 'test-model' '$TMP/stub.log' && grep -q 'Bearer test-key' '$TMP/stub.log' && grep -qF 'stream\\\":true' '$TMP/stub.log'"
check "send turn sent the prior assistant turn as history" \
  sh -c "grep -q 'add a footer' '$TMP/stub.log' >/dev/null && python3 -c \"
import json
lines=[json.loads(l) for l in open('$TMP/stub.log')]
last=json.loads(lines[-1]['body'])
msgs=[(m['role'],m['content']) for m in last['messages']]
assert msgs[-1] == ('user','one more'), msgs
assert any(r=='assistant' and 'Hello' in c for r,c in msgs), msgs
\"" 

# --- model failure rolls back the empty assistant --------------------------
stop_api
NEXOS_API_PORT="$API_PORT" NEXOS_API_STATE_DIR="$TMP/api" \
  NEXOS_API_MODEL_URL="http://127.0.0.1:1/v1" \
  node "$NEXOS_ROOT/api/api-server.mjs" >"$TMP/api2.log" 2>&1 &
API=$!
sleep 1

ERR=$(curl -sN -X POST -H 'Content-Type: application/json' \
  -d '{"message":"boom"}' "$BASE/v2/chats/stream")
echo "$ERR" >"$TMP/err.txt"
ERR_CID=$(grep -m1 '"object":"chat"' "$TMP/err.txt" | sed 's/^data: //' | J "d['id']")
check "model failure surfaces an error event" \
  sh -c "grep -q '\"object\":\"error\"' '$TMP/err.txt'"
check "model failure rolls back the empty assistant" \
  sh -c "! curl -s '$BASE/v2/chats/$ERR_CID/messages?limit=10' | grep -q '\"role\":\"assistant\"'"

if [ "$FAIL" -eq 0 ]; then
  echo "api-model-smoke: PASS"
else
  echo "api-model-smoke: FAIL"
  exit 1
fi