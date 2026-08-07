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

check "@v0-sdk/react V0Transport round-trip passes" \
  env NEXOS_STREAM_BASE="$BASE/v2" \
    node "$NEXOS_ROOT/tests/api-react-sdk.mjs"

# --- SSE framing (raw wire format) ----------------------------------------
CHAT_STREAM=$(
  curl -s -X POST -H 'Content-Type: application/json' \
    -H "Authorization: Bearer $TOKEN" \
    -d '{"message":"build me a landing page","title":"Curl chat"}' \
    "$BASE/v2/chats/stream"
)
echo "$CHAT_STREAM" >"$TMP/chat-stream.txt"

check "createStream responds 200 text/event-stream" \
  [ "$(curl -s -o /dev/null -w '%{content_type}' -X POST -H 'Content-Type: application/json' -H "Authorization: Bearer $TOKEN" -d '{"message":"hi"}' "$BASE/v2/chats/stream")" = "text/event-stream; charset=utf-8" ]
check "createStream emits event: update frames" \
  grep -q 'event: update' "$TMP/chat-stream.txt"
check "createStream opens with a chat event" \
  grep -q '"object":"chat"' "$TMP/chat-stream.txt"
check "createStream emits a title delta event" \
  grep -q '"object":"chat.title"' "$TMP/chat-stream.txt"
check "createStream emits parts.chunk deltas" \
  grep -q '"object":"message.parts.chunk"' "$TMP/chat-stream.txt"
check "createStream emits message.usage" \
  grep -q '"object":"message.usage"' "$TMP/chat-stream.txt"
check "createStream closes with a chat snapshot" \
  grep -q '"object":"chat","id":"chat_' "$TMP/chat-stream.txt"

# --- sendStream + resume via curl -----------------------------------------
CHAT_ID=$(grep -o '"object":"chat","id":"chat_[a-f0-9]*"' "$TMP/chat-stream.txt" | head -1 | grep -o 'chat_[a-f0-9]*')

SEND_STREAM=$(
  curl -s -X POST -H 'Content-Type: application/json' \
    -H "Authorization: Bearer $TOKEN" \
    -d '{"message":"add a footer"}' \
    "$BASE/v2/chats/$CHAT_ID/messages/stream"
)
echo "$SEND_STREAM" >"$TMP/send-stream.txt"
check "sendStream opens with a message snapshot" \
  grep -q '"object":"message","id":"msg_' "$TMP/send-stream.txt"
check "sendStream closes with the final message snapshot" \
  grep -q '"finishReason":"stop"' "$TMP/send-stream.txt"

RESUME=$(
  curl -s -X POST -H "Authorization: Bearer $TOKEN" "$BASE/v2/chats/$CHAT_ID/resume"
)
echo "$RESUME" >"$TMP/resume-stream.txt"
check "resume replays a stream" \
  grep -q '"object":"message.parts.chunk"' "$TMP/resume-stream.txt"
check "resume closes with the same finish" \
  grep -q '"finishReason":"stop"' "$TMP/resume-stream.txt"

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
check "chats.create implemented in Phase 2 (200)" \
  [ "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -H "Authorization: Bearer $TOKEN" -d '{"message":"hi"}' "$BASE/v2/chats")" = "200" ]
RESOLVE_STREAM=$(
  curl -s -X POST -H 'Content-Type: application/json' -H "Authorization: Bearer $TOKEN" \
    -d '{"task":{"type":"confirmed-steps","appliedScripts":["a.sh"]}}' \
    "$BASE/v2/chats/$CHAT_ID/messages/resolve/stream"
)
echo "$RESOLVE_STREAM" >"$TMP/resolve-stream.txt"
check "resolveStream opens with a message snapshot" \
  grep -q '"object":"message","id":"msg_' "$TMP/resolve-stream.txt"
check "resolveStream streams parts.chunk deltas" \
  grep -q '"object":"message.parts.chunk"' "$TMP/resolve-stream.txt"
check "resolveStream closes with the follow-up message" \
  grep -q '"finishReason":"stop"' "$TMP/resolve-stream.txt"
check "resolveStream echoes the resolved task" \
  grep -q 'a.sh' "$TMP/resolve-stream.txt"
check "resolveStream without task -> 422" \
  [ "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -H "Authorization: Bearer $TOKEN" -d '{}' "$BASE/v2/chats/$CHAT_ID/messages/resolve/stream")" = "422" ]
check "resolveStream unknown chat -> 404" \
  [ "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -H "Authorization: Bearer $TOKEN" -d '{"task":{"type":"confirmed-steps"}}' "$BASE/v2/chats/chat_nope/messages/resolve/stream")" = "404" ]

if [ "$FAIL" -eq 0 ]; then
  echo "api-stream-smoke: PASS"
else
  echo "api-stream-smoke: FAIL"
  exit 1
fi
