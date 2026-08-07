#!/bin/bash
# v0-compatible API gateway (Phase 2) smoke test: chat/message CRUD + async +
# from-files/zip/repo + persistence across restart.
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

API_PORT=9989
ZIP_PORT=$((API_PORT + 1))
BASE="http://127.0.0.1:${API_PORT}/v2"
API=""
ZIPPY=""

cleanup() {
  [ -n "$API" ] && kill "$API" 2>/dev/null
  [ -n "$ZIPPY" ] && kill "$ZIPPY" 2>/dev/null
  wait 2>/dev/null
  rm -rf "$TMP"
}
trap cleanup EXIT

J() { python3 -c "import json,sys; d=json.load(sys.stdin); print(eval(sys.argv[1]))" "$1"; }

start_api() {
  NEXOS_API_PORT="$API_PORT" NEXOS_API_STATE_DIR="$TMP/api" \
    node "$NEXOS_ROOT/api/api-server.mjs" >"$TMP/api.log" 2>&1 &
  API=$!
  sleep 1
}

# --- fixtures --------------------------------------------------------------
mkdir -p "$TMP/files-in" "$TMP/zip-in/src"
printf '<h1>hi</h1>\n' >"$TMP/files-in/index.html"
printf 'body{}\n' >"$TMP/zip-in/src/styles.css"
printf 'let a=1\n' >"$TMP/zip-in/app.js"
python3 -c "import zipfile; z=zipfile.ZipFile('$TMP/fixture.zip','w'); z.write('$TMP/zip-in/src/styles.css','src/styles.css'); z.write('$TMP/zip-in/app.js','app.js'); z.close()"

git -C "$TMP" init -q repo 2>/dev/null
git -C "$TMP/repo" config user.email t@t
git -C "$TMP/repo" config user.name t
printf 'const x = 1\n' >"$TMP/repo/app.js"
printf '# demo\n' >"$TMP/repo/README.md"
mkdir -p "$TMP/repo/node_modules"
printf 'junk' >"$TMP/repo/node_modules/junk.js"
git -C "$TMP/repo" add -A
git -C "$TMP/repo" commit -qm init

(cd "$TMP" && exec python3 -m http.server "$ZIP_PORT" >/dev/null 2>&1) &
ZIPPY=$!
sleep 1

# --- chat CRUD -------------------------------------------------------------
start_api

CREATE=$(curl -s -X POST -H 'Content-Type: application/json' -d '{"message":"build a site","title":"My chat"}' "$BASE/chats")
check "chats.create returns 200 ChatWithUsage" \
  sh -c "echo '$CREATE' | grep -q '\"usage\":'"
CID=$(echo "$CREATE" | J "d['chat']['id']")
check "chats.create assigns a chat id" [ "${CID#chat_}" != "$CID" ]

curl -s -X POST -H 'Content-Type: application/json' -d '{"message":"second chat"}' "$BASE/chats" >/dev/null

check "chats.list returns chats" \
  sh -c "curl -s '$BASE/chats?limit=10' | grep -q '\"chats\":'"
check "chats.list paginates with a cursor" \
  sh -c "curl -s '$BASE/chats?limit=1' | grep -q '\"cursor\":\"1\"'"

check "chats.get returns the chat" \
  [ "$(curl -s "$BASE/chats/$CID" | J "d['id']")" = "$CID" ]
check "chats.get unknown chat -> 404" \
  [ "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/chats/chat_nope")" = "404" ]

check "chats.update renames the chat" \
  [ "$(curl -s -X PATCH -H 'Content-Type: application/json' -d '{"title":"Renamed"}' "$BASE/chats/$CID" | J "d['title']")" = "Renamed" ]

DUP=$(curl -s -X POST -H 'Content-Type: application/json' -d '{}' "$BASE/chats/$CID/duplicate")
DUP_ID=$(echo "$DUP" | J "d['id']")
check "chats.duplicate returns 201 with a new id" \
  sh -c "[ '$DUP_ID' != '$CID' ] && [ -n '$DUP_ID' ]"
check "chats.duplicate returns HTTP 201" \
  [ "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d '{}' "$BASE/chats/$CID/duplicate")" = "201" ]
check "chats.duplicate suffixes the title" \
  sh -c "echo '$DUP' | grep -q 'Renamed (copy)'"

# --- message CRUD ----------------------------------------------------------
SENT=$(curl -s -X POST -H 'Content-Type: application/json' -d '{"message":"add a footer"}' "$BASE/chats/$CID/messages")
MSG_ID=$(echo "$SENT" | J "d['id']")
check "messages.send returns an assistant Message" \
  sh -c "echo '$SENT' | grep -q '\"finishReason\":\"stop\"'"
check "messages.send records a restorable message" \
  sh -c "echo '$SENT' | grep -q '\"restorable\":true'"

check "messages.list returns messages with cursor" \
  sh -c "curl -s '$BASE/chats/$CID/messages?limit=2' | grep -q '\"cursor\":\"2\"'"
check "messages.list requires limit -> 422" \
  [ "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/chats/$CID/messages")" = "422" ]
check "messages.get returns the sent message" \
  [ "$(curl -s "$BASE/chats/$CID/messages/$MSG_ID" | J "d['id']")" = "$MSG_ID" ]
check "messages.get unknown message -> 404" \
  [ "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/chats/$CID/messages/msg_nope")" = "404" ]
check "messages.stop returns {messageId}" \
  [ "$(curl -s -X POST "$BASE/chats/$CID/messages/$MSG_ID/stop" | J "d['messageId']")" = "$MSG_ID" ]

check "chats.restoreMessage returns all messages" \
  sh -c "curl -s -X POST -H 'Content-Type: application/json' -d '{\"messageId\":\"$MSG_ID\"}' '$BASE/chats/$CID/restore-message' | grep -q '\"messages\":'"

# --- async variants --------------------------------------------------------
check "chats.createAsync returns 202 {chatId,messageId}" \
  sh -c "curl -s -X POST -H 'Content-Type: application/json' -d '{\"message\":\"async\"}' '$BASE/chats/async' | grep -q '\"chatId\":\"chat_'"
check "messages.sendAsync returns 202 {messageId}" \
  sh -c "curl -s -X POST -H 'Content-Type: application/json' -d '{\"message\":\"async\"}' '$BASE/chats/$CID/messages/async' | grep -q '\"messageId\":\"msg_'"

# --- source files ----------------------------------------------------------
FF=$(curl -s -X POST -H 'Content-Type: application/json' -d '{"files":[{"path":"index.html","content":"<h1>hi</h1>","encoding":"utf8"}],"title":"From files"}' "$BASE/chats/from-files")
FF_ID=$(echo "$FF" | J "d['chat']['id']")
check "chats.createFromFiles returns a chat" [ -n "$FF_ID" ]
check "chats.getFiles returns the ingested file" \
  sh -c "curl -s '$BASE/chats/$FF_ID/files' | grep -q '\"path\":\"index.html\"'"
check "chats.updateFiles replaces the file set" \
  sh -c "curl -s -X PATCH -H 'Content-Type: application/json' -d '{\"files\":[{\"path\":\"app.js\",\"content\":\"x\",\"encoding\":\"utf8\"}]}' '$BASE/chats/$FF_ID/files' | grep -q '\"path\":\"app.js\"'"
check "chats.getFiles unknown chat -> 404" \
  [ "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/chats/chat_nope/files")" = "404" ]

check "chats.createFromZip extracts and stores files" \
  sh -c "curl -s -X POST -H 'Content-Type: application/json' -d '{\"url\":\"http://127.0.0.1:$ZIP_PORT/fixture.zip\"}' '$BASE/chats/from-zip' | grep -q '\"chat\":'"
ZID=$(curl -s -X POST -H 'Content-Type: application/json' -d "{\"url\":\"http://127.0.0.1:$ZIP_PORT/fixture.zip\"}" "$BASE/chats/from-zip" | J "d['chat']['id']")
check "from-zip files visible via getFiles" \
  sh -c "curl -s '$BASE/chats/$ZID/files' | grep -q 'src/styles.css'"
check "chats.createFromZip rejects a bad URL -> 422" \
  [ "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d '{"url":"http://127.0.0.1:1/nope.zip"}' "$BASE/chats/from-zip")" = "422" ]

RID=$(curl -s -X POST -H 'Content-Type: application/json' -d "{\"repo\":{\"url\":\"$TMP/repo\"}}" "$BASE/chats/from-repo" | J "d['chat']['id']")
check "chats.createFromRepo clones and stores tracked files" \
  sh -c "curl -s '$BASE/chats/$RID/files' | grep -q '\"path\":\"app.js\"'"
check "from-repo skips vendored files" \
  sh -c "curl -s '$BASE/chats/$RID/files' | grep -qv 'node_modules'"
check "createFromRepo without repo.url -> 422" \
  [ "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d '{"repo":{}}' "$BASE/chats/from-repo")" = "422" ]

# --- downloadFiles + getConnectStatus ---------------------------------------
DL="$TMP/download.zip"
curl -s -D "$TMP/dl-headers.txt" -o "$DL" "$BASE/chats/$ZID/files/download"
check "chats.downloadFiles returns application/zip" \
  sh -c "grep -qi 'content-type: application/zip' '$TMP/dl-headers.txt'"
check "chats.downloadFiles archives the chat files" \
  sh -c "unzip -Z1 '$DL' | grep -q 'src/styles.css'"
check "chats.downloadFiles unknown chat -> 404" \
  [ "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/chats/chat_nope/files/download")" = "404" ]

check "chats.updateFiles stores a base64 file" \
  sh -c "curl -s -X PATCH -H 'Content-Type: application/json' -d '{\"files\":[{\"path\":\"blob.bin\",\"content\":\"AQIDBAU=\",\"encoding\":\"base64\"}]}' '$BASE/chats/$FF_ID/files' | grep -q '\"path\":\"blob.bin\"'"
BINDL="$TMP/blob-download.zip"
curl -s -o "$BINDL" "$BASE/chats/$FF_ID/files/download"
check "chats.downloadFiles preserves base64 content" \
  sh -c "unzip -p '$BINDL' blob.bin | od -An -tu1 | tr -d ' \n' | grep -q '12345'"

check "chats.getConnectStatus unknown chat -> 404" \
  [ "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/chats/chat_nope/connect/status?requestId=r1")" = "404" ]
check "chats.getConnectStatus requires requestId -> 422" \
  [ "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/chats/$CID/connect/status")" = "422" ]
check "chats.getConnectStatus reports not configured" \
  sh -c "curl -s '$BASE/chats/$CID/connect/status?requestId=r1' | grep -q '\"status\":\"error\"'"
printf '{"req-ready":{"id":"req-ready","status":"ready","connector":{"id":"conn","name":"Local Connect","type":"local","attachedToProject":true}}}\n' \
  >"$TMP/api/connectors.json"
check "chats.getConnectStatus returns ready when seeded" \
  sh -c "curl -s '$BASE/chats/$CID/connect/status?requestId=req-ready' | grep -q '\"status\":\"ready\"'"
check "chats.getConnectStatus ready includes the connector" \
  sh -c "curl -s '$BASE/chats/$CID/connect/status?requestId=req-ready' | grep -q '\"attachedToProject\":true'"

# --- persistence across restart -------------------------------------------
kill "$API" 2>/dev/null
wait "$API" 2>/dev/null
API=""
start_api

check "chats survive a service restart (persisted state)" \
  sh -c "curl -s '$BASE/chats?limit=100' | grep -q '\"title\":\"Second chat\"'"

if [ "$FAIL" -eq 0 ]; then
  echo "api-crud-smoke: PASS"
else
  echo "api-crud-smoke: FAIL"
  exit 1
fi
