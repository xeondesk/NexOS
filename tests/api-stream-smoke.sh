#!/bin/bash
# v0-compatible API gateway (Phase 1) smoke test: streaming wire format.
# Boots the gateway on a high port, then:
#   - runs the offline unit tests (diffpatch/v0-stream/mock-generator)
#   - runs the real-SDK round-trip test (createV0Client against this server)
#   - curls the SSE endpoints to verify framing + error semantics
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

API_PORT=9987
BASE="http://127.0.0.1:${API_PORT}"
TOKEN="stream-secret-${API_PORT}"

NEXOS_API_PORT="$API_PORT" NEXOS_API_TOKEN="$TOKEN" \
  NEXOS_API_STATE_DIR="$TMP/api" \
  node "$NEXOS_ROOT/api/api-server.mjs" >"$TMP/api.log" 2>&1 &
API=$!
sleep 1

cleanup() {
  kill "$API" 2>/dev/null
  wait "$API" 2>/dev/null
  rm -rf "$TMP"
}
trap cleanup EXIT

# --- offline unit tests ----------------------------------------------------
check "offline stream unit tests pass" \
  node "$NEXOS_ROOT/tests/api-stream-unit.mjs"

# --- real SDK round-trip ---------------------------------------------------
check "real v0 SDK round-trip passes" \
  env NEXOS_STREAM_BASE="$BASE/v2" NEXOS_STREAM_TOKEN="$TOKEN" \
    node "$NEXOS_ROOT/tests/api-stream-sdk.mjs"

# --- SSE framing (raw wire format) ----------------------------------------
CHAT_STREAM=$(
  curl -s -X POST -H 'Content-Type: application/json' \
    -H "Authorization: Bearer $TOKEN" \
    -d '{"message":"build me a landing page","title":"Curl chat"}' \
    "$BASE/v2/chats/stream"
)

check "createStream responds 200 text/event-stream" \
  [ "$(curl -s -o /dev/null -w '%{content_type}' -X POST -H 'Content-Type: application/json' -H "Authorization: Bearer $TOKEN" -d '{"message":"hi"}' "$BASE/v2/chats/stream")" = "text/event-stream; charset=utf-8" ]
check "createStream emits event: update frames" \
  sh -c "echo '$CHAT_STREAM' | grep -q 'event: update'"
check "createStream opens with a chat event" \
  sh -c "echo '$CHAT_STREAM' | grep -q '\"object\":\"chat\"'"
check "createStream emits a title delta event" \
  sh -c "echo '$CHAT_STREAM' | grep -q '\"object\":\"chat.title\"'"
check "createStream emits parts.chunk deltas" \
  sh -c "echo '$CHAT_STREAM' | grep -q '\"object\":\"message.parts.chunk\"'"
check "createStream emits message.usage" \
  sh -c "echo '$CHAT_STREAM' | grep -q '\"object\":\"message.usage\"'"
check "createStream closes with a chat snapshot" \
  sh -c "echo '$CHAT_STREAM' | grep -q '\"object\":\"chat\",\"id\":\"chat_'"

# --- sendStream + resume via curl -----------------------------------------
CHAT_ID=$(echo "$CHAT_STREAM" | grep -o '"object":"chat","id":"chat_[a-f0-9]*"' | head -1 | grep -o 'chat_[a-f0-9]*')

SEND_STREAM=$(
  curl -s -X POST -H 'Content-Type: application/json' \
    -H "Authorization: Bearer $TOKEN" \
    -d '{"message":"add a footer"}' \
    "$BASE/v2/chats/$CHAT_ID/messages/stream"
)
check "sendStream opens with a message snapshot" \
  sh -c "echo '$SEND_STREAM' | grep -q '\"object\":\"message\",\"id\":\"msg_'"
check "sendStream closes with the final message snapshot" \
  sh -c "echo '$SEND_STREAM' | grep -q '\"finishReason\":\"stop\"'"

RESUME=$(
  curl -s -X POST -H "Authorization: Bearer $TOKEN" "$BASE/v2/chats/$CHAT_ID/resume"
)
check "resume replays a stream" \
  sh -c "echo '$RESUME' | grep -q '\"object\":\"message.parts.chunk\"'"
check "resume closes with the same finish" \
  sh -c "echo '$RESUME' | grep -q '\"finishReason\":\"stop\"'"

# --- error semantics -------------------------------------------------------
check "sendStream to unknown chat -> 404" \
  [ "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -H "Authorization: Bearer $TOKEN" -d '{"message":"hi"}' "$BASE/v2/chats/chat_nope/messages/stream")" = "404" ]
check "sendStream 404 carries Error shape" \
  sh -c "curl -s -X POST -H 'Content-Type: application/json' -H \"Authorization: Bearer $TOKEN\" -d '{\"message\":\"hi\"}' '$BASE/v2/chats/chat_nope/messages/stream' | grep -q '\"message\":\"chat_not_found\"'"
check "resume unknown chat -> 404" \
  [ "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "Authorization: Bearer $TOKEN" "$BASE/v2/chats/chat_nope/resume")" = "404" ]
check "createStream without message -> 422" \
  [ "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -H "Authorization: Bearer $TOKEN" -d '{}' "$BASE/v2/chats/stream")" = "422" ]
check "sendStream without message -> 422" \
  [ "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -H "Authorization: Bearer $TOKEN" -d '{}' "$BASE/v2/chats/$CHAT_ID/messages/stream")" = "422" ]
check "chats.create still 501 in Phase 1" \
  [ "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -H "Authorization: Bearer $TOKEN" -d '{"message":"hi"}' "$BASE/v2/chats")" = "501" ]
check "resolveStream still 501 in Phase 1" \
  [ "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -H "Authorization: Bearer $TOKEN" -d '{"message":"hi"}' "$BASE/v2/chats/$CHAT_ID/messages/resolve/stream")" = "501" ]

if [ "$FAIL" -eq 0 ]; then
  echo "api-stream-smoke: PASS"
else
  echo "api-stream-smoke: FAIL"
  exit 1
fi
