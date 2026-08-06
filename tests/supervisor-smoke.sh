#!/bin/bash
# Supervisor smoke test: start / status / restart / stop lifecycle.
set -u

NEXOS_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SUPERVISOR="$NEXOS_ROOT/lib/supervisor.sh"

export NEXOS_SUPERVISE_LOG_DIR="$(mktemp -d)/logs"
export NEXOS_SUPERVISE_RUN_DIR="$(mktemp -d)/run"
mkdir -p "$NEXOS_SUPERVISE_LOG_DIR" "$NEXOS_SUPERVISE_RUN_DIR"

NAME=smoke
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

# Negation form: bare `!` cannot be passed through "$@" (it would be
# executed as a command named "!"), so invert the exit code here instead.
check_not() {
  local desc="$1"; shift
  if "$@"; then
    echo "FAIL: $desc"
    FAIL=1
  else
    echo "ok: $desc"
  fi
}

"$SUPERVISOR" stop "$NAME" >/dev/null 2>&1 || true

"$SUPERVISOR" start "$NAME" -- bash "$NEXOS_ROOT/tests/fixtures/dummy.sh"
sleep 1

PID=$(cat "$NEXOS_SUPERVISE_RUN_DIR/$NAME.pid" 2>/dev/null || echo "")
CHILD=$(cat "$NEXOS_SUPERVISE_RUN_DIR/$NAME.child.pid" 2>/dev/null || echo "")

check "pidfile written" [ -n "$PID" ]
check "child running" kill -0 "$CHILD" 2>/dev/null
check "child is supervised" \
  [ "$(ps -o pgid= -p "$CHILD" 2>/dev/null | tr -d ' ')" = "$PID" ]

# start again must be a no-op (still same supervisor)
"$SUPERVISOR" start "$NAME" -- bash "$NEXOS_ROOT/tests/fixtures/dummy.sh"
check "start is idempotent" [ "$(cat "$NEXOS_SUPERVISE_RUN_DIR/$NAME.pid")" = "$PID" ]

# restart must change the child
"$SUPERVISOR" restart "$NAME" -- bash "$NEXOS_ROOT/tests/fixtures/dummy.sh"
sleep 1
NEWCHILD=$(cat "$NEXOS_SUPERVISE_RUN_DIR/$NAME.child.pid" 2>/dev/null || echo "")
check "restart spawned new child" [ "$NEWCHILD" != "$CHILD" ] && [ -n "$NEWCHILD" ]
check "new child running" kill -0 "$NEWCHILD" 2>/dev/null

"$SUPERVISOR" stop "$NAME"
sleep 0.5
check_not "child stopped after stop" kill -0 "$NEWCHILD" 2>/dev/null
check "pidfiles removed" [ ! -e "$NEXOS_SUPERVISE_RUN_DIR/$NAME.pid" ]
# backoff restart behavior: a service that exits instantly gets restarted
"$SUPERVISOR" start "$NAME" -- sh -c 'exit 0'
sleep 3
check "crashed service restarted" \
  [ -n "$(cat "$NEXOS_SUPERVISE_RUN_DIR/$NAME.child.pid" 2>/dev/null || echo '')" ]
"$SUPERVISOR" stop "$NAME"

rm -rf "$(dirname "$NEXOS_SUPERVISE_LOG_DIR")" "$(dirname "$NEXOS_SUPERVISE_RUN_DIR")"

if [ "$FAIL" -eq 0 ]; then
  echo "supervisor-smoke: PASS"
else
  echo "supervisor-smoke: FAIL"
  exit 1
fi
