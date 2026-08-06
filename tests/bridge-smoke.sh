#!/bin/bash
# Bridge smoke test: standalone bridge serves /status and persists
# set-readonly / set-workspace-name / reload-files into the state dir.
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

PORT=9966
BASE="http://127.0.0.1:${PORT}"
export NEXOS_BRIDGE_PORT="$PORT"
export NEXOS_RUN_DIR="$TMP/run"

node "$NEXOS_ROOT/bridge/standalone.js" >"$TMP/bridge.log" 2>&1 &
BRIDGE=$!
sleep 1

get_status() {
  curl -s "$BASE/status"
}

# --- initial status ---------------------------------------------------------
STATUS=$(get_status)
check "GET /status returns success" \
  sh -c "echo '$STATUS' | grep -q '\"success\":true'"
check "GET /status reports readonly=false" \
  sh -c "echo '$STATUS' | grep -q '\"readonly\":false'"

# --- set-readonly -----------------------------------------------------------
check "POST /set-readonly accepted" \
  curl -fs -o /dev/null -X POST -H 'Content-Type: application/json' \
  -d '{"readonly":true,"reason":"review"}' "$BASE/set-readonly"
STATUS=$(get_status)
check "readonly now true in /status" \
  sh -c "echo '$STATUS' | grep -q '\"readonly\":true'"

# --- set-workspace-name -----------------------------------------------------
check "POST /set-workspace-name accepted" \
  curl -fs -o /dev/null -X POST -H 'Content-Type: application/json' \
  -d '{"name":"myproject"}' "$BASE/set-workspace-name"
STATUS=$(get_status)
check "workspace name persisted to /status" \
  sh -c "echo '$STATUS' | grep -q '\"workspace\":\"myproject\"'"

# --- reload-files -----------------------------------------------------------
check "POST /reload-files accepted" \
  curl -fs -o /dev/null -X POST -H 'Content-Type: application/json' \
  -d '{"files":["a.ts","b.ts"]}' "$BASE/reload-files"

# --- validation / routing ---------------------------------------------------
check "unknown route returns 404" \
  [ "$(curl -s -o /dev/null -w '%{http_code}' -X POST -d '{}' "$BASE/nope")" = "404" ]
check "GET on POST-only route returns 405" \
  [ "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/set-readonly")" = "405" ]
check "malformed JSON returns 400" \
  [ "$(curl -s -o /dev/null -w '%{http_code}' -X POST -d 'not-json' "$BASE/set-readonly")" = "400" ]
check "readonly requires boolean" \
  [ "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d '{"readonly":"yes"}' "$BASE/set-readonly")" = "400" ]

kill "$BRIDGE" 2>/dev/null
wait "$BRIDGE" 2>/dev/null

# --- state persisted to disk ------------------------------------------------
check "workspace-name state file" [ "$(cat "$NEXOS_RUN_DIR/workspace-name" 2>/dev/null)" = "myproject" ]
check "readonly state file" [ "$(cat "$NEXOS_RUN_DIR/readonly" 2>/dev/null)" = "true" ]
check "readonly reason logged" \
  [ "$(grep -c 'review' "$NEXOS_RUN_DIR/readonly-reasons.log" 2>/dev/null)" -ge 1 ]
check "reload requests logged" \
  [ "$(grep -c 'a.ts b.ts' "$NEXOS_RUN_DIR/reload-requests.log" 2>/dev/null)" -ge 1 ]

rm -rf "$TMP"

if [ "$FAIL" -eq 0 ]; then
  echo "bridge-smoke: PASS"
else
  echo "bridge-smoke: FAIL"
  exit 1
fi
