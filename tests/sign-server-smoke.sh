#!/usr/bin/env bash
# git-sign smoke test: generates a keypair, runs the reference sign service,
# signs payloads over HTTP, and verifies the signatures with an independent
# reference verifier (tests/verify-sshsig.mjs — a faithful reimplementation of
# `ssh-keygen -Y verify`) plus the full ssh-sign.sh client path and the token
# auth gate.
#
# `ssh-keygen -Y verify` interop is asserted when the tool works. On Amazon
# Linux 2023 (OpenSSH 8.7p1 + OpenSSL 3.5.5) it rejects every signature —
# including ssh-keygen's own — with "Signature verification failed: incorrect
# signature"; that is a tool regression, not a signature defect, and the smoke
# test probes it once up front so the tool-backed checks only run where the
# tool is healthy.
set -uo pipefail
cd "$(dirname "$0")"
NEXOS_ROOT="$(cd .. && pwd)"
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
check_not() {
  local desc="$1"
  shift
  if "$@" 2>/dev/null; then
    echo "FAIL: $desc"
    failures=$((failures + 1))
  else
    echo "ok: $desc"
  fi
}

PORT=9988
IDENTITY='alice@nexos.local'
NAMESPACE='git'
VERIFY_REF() {
  node "$NEXOS_ROOT/tests/verify-sshsig.mjs" -f "$TMP/allowed-signers" \
    -I "$IDENTITY" -n "$NAMESPACE" -s "$1" "$2"
}

# --- keypair generation ---
node "$NEXOS_ROOT/git/sign-keygen.js" "$TMP" >/dev/null
check "sign-keygen writes a private key" [ -f "$TMP/sign-key.pem" ]
check "sign-keygen writes a public key" [ -f "$TMP/sign-key.pub" ]
check "private key is PKCS#8 PEM" grep -q "BEGIN PRIVATE KEY" "$TMP/sign-key.pem"
check "public key is OpenSSH format" grep -qE '^ssh-ed25519 AAAA' "$TMP/sign-key.pub"
check "private key not world-readable" [ "$(stat -c %a "$TMP/sign-key.pem")" = "600" ]

# --- start the service (loopback, no token) ---
NEXOS_GIT_SIGN_PORT="$PORT" NEXOS_GIT_SIGN_KEY="$TMP/sign-key.pem" \
  node "$NEXOS_ROOT/git/sign-server.js" >"$TMP/server.log" 2>&1 &
SERVER=$!
sleep 1

check "service health" \
  [ "$(curl -s -o /dev/null -w '%{http_code}' -m 2 "http://127.0.0.1:$PORT/health")" = "200" ]
check "pubkey endpoint matches generated key" \
  [ "$(curl -s -m 2 "http://127.0.0.1:$PORT/pubkey")" = "$(cat "$TMP/sign-key.pub")" ]
check "missing namespace rejected" \
  [ "$(curl -s -o /dev/null -w '%{http_code}' -m 2 -X POST --data-binary 'x' "http://127.0.0.1:$PORT/sign")" = "400" ]
check "unknown route 404" \
  [ "$(curl -s -o /dev/null -w '%{http_code}' -m 2 "http://127.0.0.1:$PORT/nope")" = "404" ]

# --- wire-contract guards (fixes A-D; hosted v0 parity, lenient by default) ---
check "non-whitelisted namespace rejected (400)" \
  [ "$(curl -s -o /dev/null -w '%{http_code}' -m 2 -X POST -H 'x-v0-git-signing-namespace: git:commit' --data-binary 'x' "http://127.0.0.1:$PORT/sign")" = "400" ]
check "non-whitelisted namespace returns the hosted error shape" \
  sh -c "curl -s -m 2 -X POST -H 'x-v0-git-signing-namespace: git:commit' --data-binary 'x' 'http://127.0.0.1:$PORT/sign' | grep -q 'Invalid signing namespace'"
check "empty payload rejected (400)" \
  [ "$(curl -s -o /dev/null -w '%{http_code}' -m 2 -X POST -H 'x-v0-git-signing-namespace: git' "http://127.0.0.1:$PORT/sign")" = "400" ]
check "empty payload returns the hosted error shape" \
  sh -c "curl -s -m 2 -X POST -H 'x-v0-git-signing-namespace: git' 'http://127.0.0.1:$PORT/sign' | grep -q 'Signing payload is empty'"
check "content-type not enforced by default (octet-stream still signs)" \
  [ "$(curl -s -o /dev/null -w '%{http_code}' -m 2 -X POST -H 'content-type: application/octet-stream' -H 'x-v0-git-signing-namespace: git' --data-binary 'x' "http://127.0.0.1:$PORT/sign")" = "200" ]

# --- sign + verify ---
printf 'nexos sign test payload\nline two\n' >"$TMP/data.txt"
curl -s -m 5 -X POST -H "x-v0-git-signing-namespace: $NAMESPACE" \
  --data-binary @"$TMP/data.txt" "http://127.0.0.1:$PORT/sign" -o "$TMP/direct.sig"
check "POST /sign returns an armored signature" \
  [ "$(head -1 "$TMP/direct.sig")" = "-----BEGIN SSH SIGNATURE-----" ]

printf '%s %s\n' "$IDENTITY" "$(cat "$TMP/sign-key.pub")" >"$TMP/allowed-signers"
check "reference verifier accepts the signature" \
  VERIFY_REF "$TMP/direct.sig" "$TMP/data.txt"
check_not "signature bound to its namespace" \
  node "$NEXOS_ROOT/tests/verify-sshsig.mjs" -f "$TMP/allowed-signers" \
    -I "$IDENTITY" -n "wrong-namespace" -s "$TMP/direct.sig" "$TMP/data.txt"

# --- full client path through git/ssh-sign.sh ---
NEXOS_GIT_SIGN_URL="http://127.0.0.1:$PORT/sign" \
  bash "$NEXOS_ROOT/git/ssh-sign.sh" -Y sign -n "$NAMESPACE" -f "$TMP/sign-key.pub" \
  "$TMP/data.txt" >/dev/null 2>&1
check "ssh-sign.sh produces <payload>.sig" [ -s "$TMP/data.txt.sig" ]
check "signature from ssh-sign.sh verifies" \
  VERIFY_REF "$TMP/data.txt.sig" "$TMP/data.txt"

# --- real OpenSSH interop, only where ssh-keygen -Y verify is healthy ---
printf 'tool selftest\n' >"$TMP/selftest.txt"
ssh-keygen -t ed25519 -N '' -f "$TMP/selftest-key" >/dev/null 2>&1
ssh-keygen -Y sign -f "$TMP/selftest-key" -n "$NAMESPACE" "$TMP/selftest.txt" >/dev/null 2>&1
printf '%s %s\n' "$IDENTITY" "$(cat "$TMP/selftest-key.pub")" >"$TMP/selftest-allowed-signers"
if ssh-keygen -Y verify -f "$TMP/selftest-allowed-signers" -I "$IDENTITY" -n "$NAMESPACE" \
    -s "$TMP/selftest.txt.sig" "$TMP/selftest.txt" >/dev/null 2>&1; then
  check "ssh-keygen -Y verify accepts the signature" \
    ssh-keygen -Y verify -f "$TMP/allowed-signers" -I "$IDENTITY" -n "$NAMESPACE" \
      -s "$TMP/direct.sig" "$TMP/data.txt"
  check_not "ssh-keygen -Y verify respects namespace binding" \
    ssh-keygen -Y verify -f "$TMP/allowed-signers" -I "$IDENTITY" -n "wrong-namespace" \
      -s "$TMP/direct.sig" "$TMP/data.txt"
  check "ssh-keygen -Y verify accepts ssh-sign.sh output" \
    ssh-keygen -Y verify -f "$TMP/allowed-signers" -I "$IDENTITY" -n "$NAMESPACE" \
      -s "$TMP/data.txt.sig" "$TMP/data.txt"
else
  echo "note: ssh-keygen -Y verify is broken on this host (OpenSSH 8.7p1 + OpenSSL 3.5.5) — it rejects even its own signatures; tool-backed interop checks skipped (reference verifier covers them)"
fi

# --- tightened wire-contract mode (hosted v0 exact behavior) ----------------
PORT_T=$((PORT + 2))
NEXOS_GIT_SIGN_PORT="$PORT_T" NEXOS_GIT_SIGN_KEY="$TMP/sign-key.pem" \
  NEXOS_GIT_SIGN_REQUIRE_CONTENT_TYPE=true NEXOS_GIT_SIGN_DEFAULT_NAMESPACE=git \
  NEXOS_GIT_SIGN_ALLOWED_NAMESPACES=git \
  node "$NEXOS_ROOT/git/sign-server.js" >"$TMP/server-tight.log" 2>&1 &
SERVER_T=$!
sleep 1
TBASE="http://127.0.0.1:$PORT_T"

check "content-type required -> missing content-type 415" \
  [ "$(curl -s -o /dev/null -w '%{http_code}' -m 2 -X POST -H 'x-v0-git-signing-namespace: git' --data-binary 'x' "$TBASE/sign")" = "415" ]
check "content-type required -> wrong content-type 415" \
  [ "$(curl -s -o /dev/null -w '%{http_code}' -m 2 -X POST -H 'content-type: application/octet-stream' -H 'x-v0-git-signing-namespace: git' --data-binary 'x' "$TBASE/sign")" = "415" ]
check "content-type required -> returns the hosted error shape" \
  sh -c "curl -s -m 2 -X POST -H 'x-v0-git-signing-namespace: git' --data-binary 'x' '$TBASE/sign' | grep -q 'Unsupported content type'"
check "content-type required -> exact request type signs" \
  [ "$(curl -s -o /dev/null -w '%{http_code}' -m 2 -X POST -H 'content-type: application/vnd.git.ssh-signature-request' -H 'x-v0-git-signing-namespace: git' --data-binary 'x' "$TBASE/sign")" = "200" ]
curl -s -m 2 -X POST -H 'content-type: application/vnd.git.ssh-signature-request' \
  -H 'x-v0-git-signing-namespace: git' --data-binary 'x' "$TBASE/sign" -o "$TMP/tight.sig"
printf 'x' >"$TMP/x.txt"
check "content-type required signature verifies" \
  VERIFY_REF "$TMP/tight.sig" "$TMP/x.txt"
curl -s -m 2 -X POST -H 'content-type: application/vnd.git.ssh-signature-request' \
  --data-binary 'x' "$TBASE/sign" -o "$TMP/tight-default.sig"
check "default namespace (git) signs when header absent" \
  [ "$(head -1 "$TMP/tight-default.sig")" = "-----BEGIN SSH SIGNATURE-----" ]
check "default-namespace signature verifies as git" \
  VERIFY_REF "$TMP/tight-default.sig" "$TMP/x.txt"

kill "$SERVER_T" 2>/dev/null
wait "$SERVER_T" 2>/dev/null

# --- "*" disables the namespace whitelist ------------------------------------
PORT_W=$((PORT + 3))
NEXOS_GIT_SIGN_PORT="$PORT_W" NEXOS_GIT_SIGN_KEY="$TMP/sign-key.pem" \
  NEXOS_GIT_SIGN_ALLOWED_NAMESPACES='*' \
  node "$NEXOS_ROOT/git/sign-server.js" >"$TMP/server-wild.log" 2>&1 &
SERVER_W=$!
sleep 1
check "NEXOS_GIT_SIGN_ALLOWED_NAMESPACES=* accepts any namespace" \
  [ "$(curl -s -o /dev/null -w '%{http_code}' -m 2 -X POST -H 'x-v0-git-signing-namespace: custom-ns' --data-binary 'x' "http://127.0.0.1:$PORT_W/sign")" = "200" ]
kill "$SERVER_W" 2>/dev/null
wait "$SERVER_W" 2>/dev/null

kill "$SERVER" 2>/dev/null
wait "$SERVER" 2>/dev/null

# --- token gate for remote clients ---
REMOTE_IP=$(ip -o -4 addr show scope global 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | head -1)
if [ -n "$REMOTE_IP" ]; then
  PORT2=$((PORT + 1))
  NEXOS_GIT_SIGN_PORT="$PORT2" NEXOS_GIT_SIGN_KEY="$TMP/sign-key.pem" \
    NEXOS_GIT_SIGN_TOKEN="secret-$PORT" NEXOS_ALLOW_REMOTE=true \
    node "$NEXOS_ROOT/git/sign-server.js" >"$TMP/server2.log" 2>&1 &
  SERVER2=$!
  sleep 1
  check "remote without token gets 401" \
    [ "$(curl -s -o /dev/null -w '%{http_code}' -m 2 "http://$REMOTE_IP:$PORT2/health")" = "401" ]
  check "remote with wrong token gets 401" \
    [ "$(curl -s -o /dev/null -w '%{http_code}' -m 2 -H "Authorization: Bearer nope" "http://$REMOTE_IP:$PORT2/health")" = "401" ]
  check "remote with valid token is served" \
    [ "$(curl -s -o /dev/null -w '%{http_code}' -m 2 -H "Authorization: Bearer secret-$PORT" "http://$REMOTE_IP:$PORT2/health")" = "200" ]
  check "loopback needs no token even when configured" \
    [ "$(curl -s -o /dev/null -w '%{http_code}' -m 2 "http://127.0.0.1:$PORT2/health")" = "200" ]
  kill "$SERVER2" 2>/dev/null
  wait "$SERVER2" 2>/dev/null
else
  echo "skipped: no non-loopback interface for token-reachability check"
fi

if [ "$failures" -eq 0 ]; then
  echo "sign-server-smoke: PASS"
else
  echo "sign-server-smoke: FAIL ($failures)"
  exit 1
fi
