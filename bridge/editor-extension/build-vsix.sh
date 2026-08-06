#!/usr/bin/env bash
# Build an installable VSIX for the NexOS Bridge code-server extension.
#
# The transport (`../bridge-api.js`) is vendored into the package as
# `./bridge-api.js`, and the source-tree fallback require is stripped from a
# staged copy of `extension.js`, so the VSIX is fully self-contained.
#
# Requires Node >= 18 (for `npx`). The VSIX lands in this directory.
#
#   bash build-vsix.sh
#   code-server --install-extension nexos-bridge-0.1.0.vsix
set -euo pipefail
EXT_DIR="$(cd "$(dirname "$0")" && pwd)"
VERSION="$(node -p "require('$EXT_DIR/package.json').version")"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

cp "$EXT_DIR/../bridge-api.js" "$STAGE/bridge-api.js"
cp "$EXT_DIR/package.json" "$EXT_DIR/README.md" "$EXT_DIR/LICENSE" "$STAGE/"

node - "$EXT_DIR/extension.js" "$STAGE/extension.js" <<'NODE'
const fs = require('fs')
const [src, dst] = process.argv.slice(2)
const code = fs.readFileSync(src, 'utf8')
const vendored = code.replace(
  /let NexOSBridgeApiServer[\s\S]*?\}\n\n/,
  "const { NexOSBridgeApiServer } = require('./bridge-api')\n\n",
)
if (vendored === code) {
  console.error('build-vsix: could not strip source-tree fallback require')
  process.exit(1)
}
fs.writeFileSync(dst, vendored)
NODE

(cd "$STAGE" && npx --yes @vscode/vsce package \
  --allow-missing-repository \
  -o "$EXT_DIR/nexos-bridge-$VERSION.vsix" >/dev/null)

echo "built $EXT_DIR/nexos-bridge-$VERSION.vsix"
