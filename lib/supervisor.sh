#!/bin/bash
# nexos-supervise: minimal per-service process supervisor.
#
# Migrated from the v0 sandbox's v0-supervise.sh; all v0-specific paths are
# now derived from this script's location ($NEXOS_ROOT) and overridable via
# NEXOS_* environment variables.
#
#   nexos-supervise.sh start <name> -- <command...>    no-op if already supervised
#   nexos-supervise.sh restart <name> -- <command...>  stop (incl. legacy pm2) + start
#   nexos-supervise.sh stop <name>                     kill the process group
#   nexos-supervise.sh run <name> -- <command...>      internal supervisor loop

set -u

# --- NexOS layout ---------------------------------------------------------
NEXOS_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="${NEXOS_SUPERVISE_LOG_DIR:-$NEXOS_ROOT/state/logs}"
RUN_DIR="${NEXOS_SUPERVISE_RUN_DIR:-$NEXOS_ROOT/state/run}"
MAX_LOG_BYTES="${NEXOS_SUPERVISE_MAX_LOG_BYTES:-10485760}"

cmd="${1:?usage: nexos-supervise.sh start|restart|stop|run <name> [-- command...]}"
name="${2:?missing service name}"
shift 2
if [ "${1:-}" = "--" ]; then shift; fi

pidfile="$RUN_DIR/$name.pid"
childfile="$RUN_DIR/$name.child.pid"
logfile="$LOG_DIR/$name.log"

# Pidfiles under RUN_DIR survive a pause/resume of the host, but a resumed
# boot has a fresh PID namespace: the recorded pids are dead and get recycled
# by unrelated new processes. A bare kill -0 therefore proves nothing — every
# use of a stored pid must verify the live process is really the one the file
# described before trusting (or killing) it.
is_our_supervisor() {
  local pid="$1"
  [ -n "$pid" ] || return 1
  # ps prints nothing for a dead pid, so this is the liveness check too.
  # Match on the basename so it works regardless of how the script is
  # invoked (absolute path, ./relative, or via PATH).
  ps -o command= -p "$pid" 2>/dev/null | grep -qF "$(basename "$0") run $name"
}

supervisor_alive() {
  local pid
  pid=$(cat "$pidfile" 2>/dev/null) || return 1
  is_our_supervisor "$pid"
}

truncate_log_if_big() {
  local size
  size=$(stat -c %s "$logfile" 2>/dev/null || echo 0)
  if [ "$size" -gt "$MAX_LOG_BYTES" ]; then
    : >"$logfile"
  fi
}

spawn_supervisor() {
  # 9>&- is load-bearing: fd 9 holds the flock, and flock follows the open
  # file description into children. Without closing it the supervisor (and
  # its service child) would hold the lock forever, deadlocking every
  # subsequent stop/restart of this service.
  setsid "$0" run "$name" -- "$@" 9>&- >>"$logfile" 2>&1 &
  echo $! >"$pidfile"
}

# TERM the group, give it ~2.5s to drain (slow-but-clean shutdowns release
# their port in here), then KILL whatever ignored the TERM. Waiting also
# means restart never spawns the new instance while the old one still holds
# the port — that used to EADDRINUSE-crash the new instance into the
# backoff loop. Sleeps are front-loaded so services that exit promptly
# (the common case) cost ~20-50ms here, not a flat 100ms.
kill_group_with_escalation() {
  local pgid="$1" delay i
  kill -TERM -- "-$pgid" 2>/dev/null || kill -TERM "$pgid" 2>/dev/null || true
  for delay in 0.02 0.03 0.05; do
    kill -0 -- "-$pgid" 2>/dev/null || return 0
    sleep "$delay"
  done
  for ((i = 0; i < 24; i++)); do
    kill -0 -- "-$pgid" 2>/dev/null || return 0
    sleep 0.1
  done
  kill -0 -- "-$pgid" 2>/dev/null || return 0
  kill -KILL -- "-$pgid" 2>/dev/null || kill -KILL "$pgid" 2>/dev/null || true
}

stop_service() {
  local pid child
  # Fast path: no recorded state means nothing to stop — spares the fresh
  # boot start (the common resume-path case) the pid checks and pgrep below.
  if [ ! -e "$pidfile" ] && [ ! -e "$childfile" ]; then
    return 0
  fi
  pid=$(cat "$pidfile" 2>/dev/null) || pid=""
  if is_our_supervisor "$pid"; then
    kill_group_with_escalation "$pid"
  elif [ -n "$pid" ]; then
    # The pidfile is stale (recycled or dead pid) — but the service child of
    # a supervisor that died alone (e.g. OOM-killed) may still be running.
    # It provably belongs to us if its pgid is the dead supervisor's pid;
    # an unrelated recycled pid cannot share that link.
    child=$(cat "$childfile" 2>/dev/null) || child=""
    if [ -n "$child" ] && kill -0 "$child" 2>/dev/null &&
      [ "$(ps -o pgid= -p "$child" 2>/dev/null | tr -d ' ')" = "$pid" ]; then
      kill_group_with_escalation "$pid"
    fi
  fi
  rm -f "$pidfile" "$childfile"
  # Hosts resumed from pre-supervise snapshots may still run this service
  # under pm2. Only talk to pm2 when its daemon is already alive — any pm2
  # command against a dead daemon boots it (~1.6s) just to answer.
  if pgrep -f "PM2.*God Daemon" >/dev/null 2>&1; then
    pm2 delete "$name" >/dev/null 2>&1 || true
  fi
}

case "$cmd" in
  run)
    # Supervisor loop; runs as session leader. `stop` TERMs the whole
    # process group, so the child dies alongside us — the trap just exits.
    trap 'exit 0' TERM INT
    backoff=1
    while :; do
      truncate_log_if_big
      started=$(date +%s)
      "$@" &
      echo $! >"$childfile"
      wait $!
      code=$?
      ended=$(date +%s)
      if [ $((ended - started)) -ge 30 ]; then backoff=1; fi
      echo "[nexos-supervise] $name exited with code $code; restarting in ${backoff}s"
      sleep "$backoff" &
      wait $!
      backoff=$((backoff * 2))
      if [ "$backoff" -gt 30 ]; then backoff=30; fi
    done
    ;;
  start | restart)
    mkdir -p "$LOG_DIR" "$RUN_DIR"
    exec 9>"$RUN_DIR/$name.lock"
    flock 9
    if [ "$cmd" != "restart" ] && supervisor_alive; then
      exit 0
    fi
    # Restart, or no verifiable supervisor: clear stale pidfiles and reap
    # any orphaned service child so start never duplicates a survivor.
    stop_service
    spawn_supervisor "$@"
    ;;
  stop)
    mkdir -p "$RUN_DIR"
    exec 9>"$RUN_DIR/$name.lock"
    flock 9
    stop_service
    ;;
  *)
    echo "nexos-supervise: unknown command: $cmd" >&2
    exit 2
    ;;
esac
