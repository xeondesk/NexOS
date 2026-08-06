#!/bin/bash
# NexOS container entrypoint.
#
# Ensures runtime dirs + identity template exist, starts the supervised
# services (gated per-service), and stays alive until the container is
# stopped, then shuts every service down cleanly.
set -u

NEXOS_ROOT=/opt/nexos
NEXOS_CLI="$NEXOS_ROOT/bin/nexos"
CONF="$NEXOS_ROOT/config/nexos.conf"
. "$CONF"

STOPPED=0

service_enabled() {
  # Enabled by default; disable explicitly with NEXOS_ENABLE_<SERVICE>=false.
  local varname
  varname="NEXOS_ENABLE_$(echo "$1" | tr '[:lower:]' '[:upper:]' | tr '-' '_')"
  [ "${!varname:-}" != "false" ]
}

has_callback() {
  # Env var wins; else look in the identity file (NEXOS_* or legacy V0_*),
  # requiring a non-empty value.
  [ -n "${NEXOS_CALLBACK_URL:-}" ] && return 0
  local f="${NEXOS_ENV_FILE:-$NEXOS_ROOT/config/nexos.env}"
  [ -f "$f" ] || return 1
  grep -qE "^(NEXOS_CALLBACK_URL|NEXOS_CODE_SERVER_CALLBACK_URL|V0_CODE_SERVER_CALLBACK_URL)='?[^'[:space:]]" "$f"
}

ensure_state() {
  mkdir -p "$NEXOS_LOG_DIR" "$NEXOS_RUN_DIR" "$NEXOS_CONFIG_DIR" \
    "$NEXOS_USER_DATA_DIR" "$NEXOS_WORKSPACE"
  if [ ! -f "$NEXOS_ENV_FILE" ] && [ -f "$NEXOS_ROOT/config/nexos.env.example" ]; then
    cp "$NEXOS_ROOT/config/nexos.env.example" "$NEXOS_ENV_FILE"
  fi
}

start_one() {
  local name="$1"
  if ! service_enabled "$name"; then
    echo "[entrypoint] $name disabled, skipping"
    return 0
  fi
  case "$name" in
    editor)   command -v code-server >/dev/null 2>&1 || { echo "[entrypoint] editor skipped (code-server not installed)"; return 0; } ;;
    terminal) command -v ttyd >/dev/null 2>&1 || { echo "[entrypoint] terminal skipped (ttyd not installed)"; return 0; } ;;
    metrics)  has_callback || { echo "[entrypoint] metrics skipped (no callback configured)"; return 0; } ;;
    bridge)   : ;;
  esac
  "$NEXOS_CLI" start "$name"
  echo "[entrypoint] started $name"
}

stop_all() {
  [ "$STOPPED" -eq 1 ] && return 0
  STOPPED=1
  echo "[entrypoint] shutting down services..."
  for name in log-proxy editor terminal metrics bridge; do
    "$NEXOS_CLI" stop "$name" 2>/dev/null || true
  done
}

trap 'stop_all; exit 0' TERM INT

ensure_state
start_one log-proxy
start_one editor
start_one terminal
start_one metrics
start_one bridge

echo "[entrypoint] NexOS ready — editor :${NEXOS_EDITOR_PORT}, terminal :${NEXOS_TERMINAL_PORT}, control plane :${NEXOS_LOG_PROXY_PORT}, bridge :${NEXOS_BRIDGE_PORT}"

# Sleep loop that stays interruptible by the trap above.
while :; do
  sleep 3600 &
  wait $! || true
done
