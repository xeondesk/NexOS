#!/bin/bash
# NexOS editor service — code-server (VS Code web).
#
# Migrated from the v0 sandbox's v0-code-server.sh. The editor serves the
# configured NEXOS_WORKSPACE on NEXOS_EDITOR_PORT; state (config + user data)
# persists under the NexOS state dir.

set -u
NEXOS_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
. "$NEXOS_ROOT/config/nexos.conf"

mkdir -p "$NEXOS_CONFIG_DIR/code-server" "$NEXOS_USER_DATA_DIR/code-server" "$NEXOS_WORKSPACE"

CONF="$NEXOS_CONFIG_DIR/code-server/config.yaml"
if [ ! -f "$CONF" ]; then
  cat >"$CONF" <<EOF
auth: none
cert: false
EOF
fi

exec code-server \
  --bind-addr "0.0.0.0:${NEXOS_EDITOR_PORT}" \
  --config "$CONF" \
  --user-data-dir "$NEXOS_USER_DATA_DIR/code-server" \
  --disable-telemetry \
  --disable-update-check \
  --disable-getting-started-override \
  --disable-workspace-trust \
  --app-name NexOS \
  --welcome-text 'NexOS Editor' \
  "$NEXOS_WORKSPACE"
