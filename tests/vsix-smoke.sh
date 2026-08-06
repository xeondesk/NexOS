#!/usr/bin/env bash
# VSIX packaging smoke test: builds the editor-extension VSIX, verifies the
# package is self-contained (vendored bridge-api.js, no source-tree escape),
# and runs the packaged extension.js against a stubbed vscode.
set -uo pipefail
cd "$(dirname "$0")"
NEXOS_ROOT="$(cd .. && pwd)"
EXT="$NEXOS_ROOT/bridge/editor-extension"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

failures=0
check() {
  local desc="$1"
  shift
  if "$@" 2>/dev/null; then
    echo "ok: $desc"
  else
    echo "FAIL: $desc"
    failures=$((failures + 1))
  fi
}

# --- build the VSIX ---
(cd "$EXT" && bash build-vsix.sh >/dev/null)
VSIX="$(ls "$EXT"/nexos-bridge-*.vsix 2>/dev/null | head -1)"
check "VSIX was produced" [ -n "$VSIX" ]

# --- verify package contents ---
unzip -o -q "$VSIX" -d "$TMP/out" 2>/dev/null
check "package contains extension.js" [ -f "$TMP/out/extension/extension.js" ]
check "package contains vendored bridge-api.js" [ -f "$TMP/out/extension/bridge-api.js" ]
check "package contains package.json" [ -f "$TMP/out/extension/package.json" ]
if [ -f "$TMP/out/extension/README.md" ] || [ -f "$TMP/out/extension/readme.md" ]; then
  check "package contains README" true
else
  check "package contains README" false
fi
if rg -q "require\('\.\./bridge-api'\)" "$TMP/out/extension/extension.js" 2>/dev/null; then
  check "packaged extension does not reach outside the package" false
else
  check "packaged extension does not reach outside the package" true
fi

# --- run the packaged extension against a stubbed vscode ---
node "$NEXOS_ROOT/tests/vsix-load.mjs" "$TMP/out/extension/extension.js" 9971
[ $? -eq 0 ] || failures=$((failures + 1))

if [ "$failures" -eq 0 ]; then
  echo "vsix-smoke: PASS"
else
  echo "vsix-smoke: FAIL ($failures)"
  exit 1
fi
