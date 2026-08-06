#!/bin/bash
# NexOS terminal service — ttyd (web terminal).
#
# Migrated from the v0 sandbox's v0-ttyd.sh. Serves a login shell rooted at
# NEXOS_WORKSPACE on NEXOS_TERMINAL_PORT.

set -u
NEXOS_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
. "$NEXOS_ROOT/config/nexos.conf"

mkdir -p "$NEXOS_WORKSPACE"

exec ttyd \
  -p "${NEXOS_TERMINAL_PORT}" \
  -W \
  -w "$NEXOS_WORKSPACE" \
  -t 'disableLeaveAlert=true' \
  -t 'disableResizeOverlay=true' \
  -t 'fontSize=14' \
  -t 'lineHeight=1.2' \
  -t 'fontFamily=Geist Mono, ui-monospace, SFMono-Regular, SF Mono, Menlo, Monaco, Consolas, monospace' \
  -t 'theme={"background":"#0a0a0a","foreground":"#e0e0e0","cursor":"#3b82f6","cursorAccent":"#000000","selectionBackground":"rgba(59, 130, 246, 0.3)","black":"#000000","red":"#ff5555","green":"#50fa7b","yellow":"#f1fa8c","blue":"#bd93f9","magenta":"#ff79c6","cyan":"#8be9fd","white":"#bbbbbb","brightBlack":"#555555","brightRed":"#ff5555","brightGreen":"#50fa7b","brightYellow":"#f1fa8c","brightBlue":"#bd93f9","brightMagenta":"#ff79c6","brightCyan":"#8be9fd","brightWhite":"#ffffff"}' \
  bash -l
