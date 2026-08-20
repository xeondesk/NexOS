#!/bin/bash
# Agent-browser ingress smoke test: path routing (/proxy/<port>/<path>, v0
# VSCODE_PROXY_URI parity), host routing (<sub>.nexos.build via
# NEXOS_INGRESS_ROUTES + numeric-subdomain convenience), header hygiene (Host
# rewrite + X-Forwarded-For), WebSocket upgrade passthrough (HMR round-trip),
# SSRF guards (non-numeric / out-of-range ports), and remote token auth.
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

INGRESS_PORT=9990
ECHO_PORT=9991
WS_PORT=9992
AUTH_PORT=9993

# --- HTTP echo backend (reports method/url/host/x-forwarded-for + body) ------
ECHO_PORT="$ECHO_PORT" node -e '
const http = require("http");
const port = Number(process.env.ECHO_PORT);
http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      method: req.method,
      url: req.url,
      host: req.headers.host,
      via: req.headers["x-forwarded-for"] || null,
      body,
    }));
  });
}).listen(port, "127.0.0.1");
' >"$TMP/echo.log" 2>&1 &
ECHO=$!

# --- WebSocket echo backend (uppercases messages) -----------------------------
NODE_PATH="$NEXOS_ROOT/node_modules" WS_PORT="$WS_PORT" node -e '
const { WebSocketServer } = require("ws");
const port = Number(process.env.WS_PORT);
const wss = new WebSocketServer({ port });
wss.on("connection", (ws) => ws.on("message", (d) => ws.send(d.toString().toUpperCase())));
' >"$TMP/ws.log" 2>&1 &
WS=$!
sleep 0.5

# --- ingress (loopback; default host routes overridden to hit the echo) ------
NEXOS_INGRESS_PORT="$INGRESS_PORT" \
NEXOS_INGRESS_ROUTES="{\"*.nexos.build\":\"http://127.0.0.1:${ECHO_PORT}\"}" \
  node "$NEXOS_ROOT/lib/ingress.js" >"$TMP/ingress.log" 2>&1 &
INGRESS=$!
sleep 1

BASE="http://127.0.0.1:${INGRESS_PORT}"

# --- path routing (/proxy/<port>/<path>, v0 parity) --------------------------
check "path route /proxy/<port>/ forwards to the port" \
  sh -c "curl -s '$BASE/proxy/$ECHO_PORT/ping' | grep -q '\"url\":\"/ping\"'"
check "path route preserves the query string" \
  sh -c "curl -s '$BASE/proxy/$ECHO_PORT/echo?a=1' | grep -q '\"url\":\"/echo?a=1\"'"
check "path route forwards method and body" \
  sh -c "curl -s -X POST -d hello '$BASE/proxy/$ECHO_PORT/' | grep -q '\"body\":\"hello\"'"
check "path route rewrites the Host header to the upstream" \
  sh -c "curl -s '$BASE/proxy/$ECHO_PORT/' | grep -q '\"host\":\"127.0.0.1:$ECHO_PORT\"'"
check "path route sets X-Forwarded-For" \
  sh -c "curl -s '$BASE/proxy/$ECHO_PORT/' | grep -q '\"via\":\"127.0.0.1\"'"
check "path route non-numeric port -> 404" \
  [ "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/proxy/abc/x")" = "404" ]
check "path route out-of-range port -> 400" \
  [ "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/proxy/99999/x")" = "400" ]

# --- host routing (<sub>.nexos.build + numeric subdomain) --------------------
check "host route via NEXOS_INGRESS_ROUTES" \
  sh -c "curl -s -H 'Host: app.nexos.build' '$BASE/hello' | grep -q '\"url\":\"/hello\"'"
check "host route rewrites Host to the mapped upstream" \
  sh -c "curl -s -H 'Host: app.nexos.build' '$BASE/' | grep -q '\"host\":\"127.0.0.1:$ECHO_PORT\"'"
check "numeric subdomain host route -> loopback port" \
  sh -c "curl -s -H 'Host: $ECHO_PORT.nexos.run' '$BASE/from-port' | grep -q '\"url\":\"/from-port\"'"
check "unknown host -> 404" \
  [ "$(curl -s -o /dev/null -w '%{http_code}' -H 'Host: nope.example.com' "$BASE/")" = "404" ]
check "unroutable path under the ingress -> 404" \
  [ "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/nope")" = "404" ]

# --- WebSocket upgrade passthrough (next dev HMR shape) ----------------------
WS_OUT=$(
  NODE_PATH="$NEXOS_ROOT/node_modules" WS_PORT="$WS_PORT" INGRESS_PORT="$INGRESS_PORT" node -e '
    const { WebSocket } = require("ws");
    const wsPort = Number(process.env.WS_PORT);
    const ingressPort = Number(process.env.INGRESS_PORT);
    const ws = new WebSocket("ws://127.0.0.1:" + ingressPort + "/proxy/" + wsPort + "/ws");
    ws.on("open", () => ws.send("hello"));
    ws.on("message", (d) => { console.log("GOT:" + d.toString()); ws.close(); });
    ws.on("error", (e) => { console.log("ERR:" + e.message); process.exit(1); });
    setTimeout(() => process.exit(2), 3000);
  '
)
check "websocket upgrade proxies an echo round-trip" \
  sh -c "echo '$WS_OUT' | grep -q 'GOT:HELLO'"

kill "$INGRESS" 2>/dev/null
wait "$INGRESS" 2>/dev/null

# --- remote reachability + token auth ----------------------------------------
REMOTE_IP=$(ip -4 -o addr show scope global 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | head -1)
if [ -n "$REMOTE_IP" ]; then
  TOKEN="ingress-token-$AUTH_PORT"
  NEXOS_INGRESS_PORT="$AUTH_PORT" NEXOS_INGRESS_TOKEN="$TOKEN" NEXOS_ALLOW_REMOTE=true \
    node "$NEXOS_ROOT/lib/ingress.js" >"$TMP/ingress-auth.log" 2>&1 &
  AUTH=$!
  sleep 1
  ABASE="http://$REMOTE_IP:$AUTH_PORT"

  check "remote without token -> 401" \
    [ "$(curl -s -o /dev/null -w '%{http_code}' -m 2 "$ABASE/proxy/$ECHO_PORT/" 2>/dev/null)" = "401" ]
  check "remote with wrong token -> 401" \
    [ "$(curl -s -o /dev/null -w '%{http_code}' -m 2 -H "Authorization: Bearer nope" "$ABASE/proxy/$ECHO_PORT/" 2>/dev/null)" = "401" ]
  check "remote with valid bearer is served" \
    [ "$(curl -s -o /dev/null -w '%{http_code}' -m 2 -H "Authorization: Bearer $TOKEN" "$ABASE/proxy/$ECHO_PORT/" 2>/dev/null)" = "200" ]
  check "remote token via ?token= query is served" \
    [ "$(curl -s -o /dev/null -w '%{http_code}' -m 2 "$ABASE/proxy/$ECHO_PORT/?token=$TOKEN" 2>/dev/null)" = "200" ]
  check "loopback needs no token even when configured" \
    [ "$(curl -s -o /dev/null -w '%{http_code}' -m 2 "http://127.0.0.1:$AUTH_PORT/proxy/$ECHO_PORT/" 2>/dev/null)" = "200" ]

  kill "$AUTH" 2>/dev/null
  wait "$AUTH" 2>/dev/null
else
  echo "skipped: no non-loopback interface for remote-reachability check"
fi

kill "$ECHO" 2>/dev/null
wait "$ECHO" 2>/dev/null
kill "$WS" 2>/dev/null
wait "$WS" 2>/dev/null

rm -rf "$TMP"

if [ "$FAIL" -eq 0 ]; then
  echo "ingress-smoke: PASS"
else
  echo "ingress-smoke: FAIL"
  exit 1
fi
