#!/bin/bash
# fix-code-server-watcher.sh
#
# Repair code-server's native file watcher (@vscode/watcher) when the packaged
# watcher.node was compiled against a newer glibc than the running sandbox
# provides (e.g. rebuilt on a glibc 2.38 image, running on glibc 2.34).
#
# Symptom: /vercel/share/logs/v0-code-server.log repeatedly contains
#   [IPC Library: File Watcher] Uncaught Exception:
#   Error: /lib64/libc.so.6: version `GLIBC_2.38' not found
#   (required by .../@vscode/watcher/build/Release/watcher.node)
# The editor then can't detect/sync file changes and sessions appear to close.
#
# Fix: rebuild watcher.node from the bundled source against the local glibc,
# using Node headers matching the node code-server actually runs.
#
# Usage:
#   fix-code-server-watcher.sh              # repair if broken (safe no-op if fine)
#   fix-code-server-watcher.sh --check      # only report, never modify
#   fix-code-server-watcher.sh --force      # always rebuild + restart
#   fix-code-server-watcher.sh --no-restart # repair but leave code-server alone
#
# Requires network access to nodejs.org (to fetch matching node headers).

set -u

RUN_DIR="/vercel/share/run"
LOG_DIR="/vercel/share/logs"
CODE_SERVER_LOG="$LOG_DIR/v0-code-server.log"
SUPERVISE="/vercel/share/v0-supervise.sh"
WORKDIR="${V0_WATCHER_WORKDIR:-/tmp/opencode}"
HEADERS_CACHE="${WORKDIR}/code-server-node-headers"

MODE="${1:-auto}"

log() { printf '[fix-watcher] %s\n' "$*"; }

die() { log "ERROR: $*"; exit 1; }

# ---------------------------------------------------------------------------
# 1. Locate the @vscode/watcher package(s).
# ---------------------------------------------------------------------------
mapfile -t WATCHER_PKGS < <(find /usr/local/lib/code-server* -type d \
  -path "*/node_modules/@vscode/watcher" 2>/dev/null)
if [ "${#WATCHER_PKGS[@]}" -eq 0 ]; then
  die "no @vscode/watcher package found under /usr/local/lib/code-server*"
fi
log "found ${#WATCHER_PKGS[@]} @vscode/watcher package(s)"

# ---------------------------------------------------------------------------
# 2. Locate the node binary code-server runs (bundled node, not system node).
# ---------------------------------------------------------------------------
NODE=""
for n in /usr/local/lib/code-server*/lib/node; do
  if [ -f "$n" ] && [ -x "$n" ]; then NODE="$n"; break; fi
done
if [ -z "$NODE" ]; then NODE="$(command -v node)"; fi
[ -n "$NODE" ] && [ -x "$NODE" ] || die "cannot locate code-server node binary"
NODE_VERSION="$("$NODE" --version 2>/dev/null | sed 's/^v//')"
[ -n "$NODE_VERSION" ] || die "cannot determine node version"
log "code-server runs node v$NODE_VERSION ($NODE)"

# ---------------------------------------------------------------------------
# 3. Compare glibc the watcher.node needs vs what the system provides.
# ---------------------------------------------------------------------------
sys_glibc="$(ldd --version 2>/dev/null | head -1 | grep -oE '[0-9]+\.[0-9]+' | head -1)"
log "system glibc: ${sys_glibc:-unknown}"

# Returns true if $1 (a dotted version like 2.2.5 or 2.34) is <= system glibc.
needs_glibc_le() {
  local a_major a_minor b_major b_minor
  local rest="${1#*.}"
  a_major="${1%%.*}"; a_minor="${rest%%.*}"
  b_major="${sys_glibc%%.*}"
  rest="${sys_glibc#*.}"
  b_minor="${rest%%.*}"
  if [ "$a_major" -lt "$b_major" ]; then return 0; fi
  if [ "$a_major" -gt "$b_major" ]; then return 1; fi
  [ "$a_minor" -le "$b_minor" ]
}

watcher_ok() { # $1 = path to watcher.node
  local syms fpath="$1"
  if ! command -v objdump >/dev/null 2>&1; then return 1; fi
  [ -f "$fpath" ] || return 1
  syms="$(objdump -T "$fpath" 2>/dev/null | grep -o 'GLIBC_[0-9.]*' | sed 's/GLIBC_//' | sort -Vu)"
  [ -n "$syms" ] || return 1
  for v in $syms; do
    if ! needs_glibc_le "$v"; then return 1; fi
  done
  return 0
}

if [ "$MODE" != "--force" ] && [ "$MODE" != "--check" ] && [ "$MODE" != "auto" ] && [ "$MODE" != "--no-restart" ]; then
  die "unknown mode: $MODE (use --check, --force, --no-restart, or nothing)"
fi

if [ "$MODE" = "--force" ]; then
  log "--force: entering forced repair regardless of compatibility"
else
  needs_fix=0
  for W in "${WATCHER_PKGS[@]}"; do
    WATCHER_NODE="$W/build/Release/watcher.node"
    if watcher_ok "$WATCHER_NODE"; then
      log "ok: $WATCHER_NODE"
    else
      log "broken (needs newer glibc): $WATCHER_NODE"
      needs_fix=1
    fi
  done

  if [ "$needs_fix" -eq 0 ]; then
    log "no fix required (all watcher.node binaries are compatible)"
    exit 0
  fi

  if [ "$MODE" = "--check" ]; then
    log "fix required, but --check was given; nothing changed"
    exit 1
  fi
fi

# ---------------------------------------------------------------------------
# 4. Fetch node headers matching the runtime node.
#    Note: the headers tarball's root dir is "node-vX.Y.Z" (no "-headers"),
#    and common.gypi/config.gypi live at include/node/ inside it.
# ---------------------------------------------------------------------------
HEADERS_DIR="$HEADERS_CACHE/node-v$NODE_VERSION"
if [ ! -f "$HEADERS_DIR/include/node/common.gypi" ]; then
  rm -rf "$HEADERS_DIR"
  mkdir -p "$HEADERS_DIR" "$HEADERS_CACHE"
  log "downloading headers for node v$NODE_VERSION ..."
  curl -fsSL -o "$HEADERS_CACHE/headers.tar.gz" \
    "https://nodejs.org/download/release/v$NODE_VERSION/node-v$NODE_VERSION-headers.tar.gz" \
    || die "failed to download node headers (offline?): v$NODE_VERSION"
  tar -xzf "$HEADERS_CACHE/headers.tar.gz" -C "$HEADERS_DIR" --strip-components=1 \
    || die "failed to extract node headers"
  rm -f "$HEADERS_CACHE/headers.tar.gz"
fi
[ -f "$HEADERS_DIR/include/node/common.gypi" ] ||
  die "node headers incomplete: $HEADERS_DIR/include/node/common.gypi missing"
log "node headers at $HEADERS_DIR"

# ---------------------------------------------------------------------------
# 5. Locate node-gyp (prefer npm's bundled copy).
# ---------------------------------------------------------------------------
NODE_GYP="$(command -v node-gyp 2>/dev/null || true)"
if [ -z "$NODE_GYP" ]; then
  for cand in \
    /usr/local/lib/node_modules/npm/bin/node-gyp-bin/node-gyp \
    "$(npm root -g 2>/dev/null)/npm/bin/node-gyp-bin/node-gyp"; do
    if [ -x "$cand" ]; then NODE_GYP="$cand"; break; fi
  done
fi
[ -n "$NODE_GYP" ] && [ -x "$NODE_GYP" ] || die "cannot find node-gyp"
log "using node-gyp: $NODE_GYP"

# ---------------------------------------------------------------------------
# 6. Rebuild each broken watcher package.
# ---------------------------------------------------------------------------
for W in "${WATCHER_PKGS[@]}"; do
  WATCHER_NODE="$W/build/Release/watcher.node"
  if [ "$MODE" != "--force" ] && watcher_ok "$WATCHER_NODE"; then continue; fi

  log "rebuilding $W"
  [ -d "$W/src" ] && [ -f "$W/binding.gyp" ] || die "watcher package has no source: $W"

  # Keep the current binary safe in case the rebuild fails mid-way.
  BAK_NODE=""
  if [ -f "$WATCHER_NODE" ]; then
    BAK_NODE="$W/build/Release/watcher.node.bak"
    cp -p "$WATCHER_NODE" "$BAK_NODE"
  fi

  # Resolve node-addon-api (declared in binding.gyp via require('node-addon-api'))
  NAA_REAL="$(find /usr/local/lib/code-server* -maxdepth 8 \
    -type d -path "*/node_modules/.pnpm/node-addon-api@*/node_modules/node-addon-api" \
    2>/dev/null | sort -V | tail -1)"
  [ -n "$NAA_REAL" ] || die "cannot find node-addon-api in the code-server store"
  mkdir -p "$W/node_modules"
  ln -sfn "$NAA_REAL" "$W/node_modules/node-addon-api"
  node -e "require('$W/node_modules/node-addon-api').include_dir" >/dev/null 2>&1 \
    || die "node-addon-api not resolvable from $W"

  rm -rf "$W/build"
  ( cd "$W" || exit 1
    export npm_config_nodedir="$HEADERS_DIR" npm_config_build_from_source=true
    "$NODE_GYP" --nodedir="$HEADERS_DIR" configure &&
    make -C build -j"$(nproc)" BUILDTYPE=Release ) \
    || {
      if [ -n "$BAK_NODE" ]; then
        mkdir -p "$(dirname "$WATCHER_NODE")"
        cp -p "$BAK_NODE" "$WATCHER_NODE"
        log "rebuild failed; restored previous watcher.node"
      fi
      die "node-gyp/make rebuild failed for $W"
    }
  # make -C build produces build/Release/obj.target/watcher.node and also
  # copies to build/Release/watcher.node; ensure the canonical path exists.
  [ -f "$WATCHER_NODE" ] || cp -f "$W/build/Release/obj.target/watcher.node" "$WATCHER_NODE"

  watcher_ok "$WATCHER_NODE" \
    || die "rebuilt watcher.node still requires too-new glibc: $WATCHER_NODE"

  # Verify the artifact actually loads under code-server's node.
  if ! "$NODE" -e "require(process.argv[1])" "$WATCHER_NODE" >/dev/null 2>&1; then
    [ -n "$BAK_NODE" ] && cp -p "$BAK_NODE" "$WATCHER_NODE"
    die "rebuilt watcher.node failed to load under node v$NODE_VERSION"
  fi
  rm -f "$BAK_NODE"
  log "rebuilt + verified: $WATCHER_NODE"
done

# ---------------------------------------------------------------------------
# 7. Restart code-server if it is supervised & running (skip with --no-restart,
#    e.g. when invoked from v0-code-server.sh itself).
# ---------------------------------------------------------------------------
if [ "$MODE" = "--no-restart" ]; then
  log "skipping restart (--no-restart)"
elif [ -x "$SUPERVISE" ] && [ -f "$RUN_DIR/v0-code-server.pid" ]; then
  log "restarting v0-code-server (this briefly closes the open editor tab)"
  bash "$SUPERVISE" restart v0-code-server -- bash -c 'bash /vercel/share/v0-code-server.sh'
  log "restart issued; check $CODE_SERVER_LOG for a clean start"
else
  log "code-server not running or not supervised; restart it manually"
fi
