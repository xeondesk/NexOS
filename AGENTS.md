# NexOS — agent working notes

## What this is

Self-hosted dev-environment orchestration system, migrated from the Vercel v0
sandbox platform. Supervises editor/terminal services, streams logs over WS,
runs commands through a localhost control plane, reports metrics, injects
framework runtime hooks, and ships git identity helpers. `/vercel/share/v0-project/`
is explicitly out of scope for migration.

## Layout

- `bin/nexos` — CLI (init/start/restart/stop/status/run/exec/version)
- `bin/entrypoint.sh` — container entrypoint (starts services, signal handling)
- `config/nexos.conf` — `NEXOS_*` path/port/env defaults
- `config/nexos.env.example` — callback identity template (never commit real `nexos.env`)
- `lib/` — supervisor.sh, log-proxy.js, metrics.sh, register.mjs, config-loader.mjs
- `services/` — editor.sh (code-server), terminal.sh (ttyd)
- `bridge/bridge-api.js` — standalone control API for editor hosts
- `web/` — api-server.js (portal API) + index.html (no-build dashboard)
- `api/` — api-server.mjs (v0-compatible v2 API gateway) + openapi-v2.json (contract)
- `git/` — ssh-sign.sh, sign-server.js, sign-keygen.js, allowed-signers, credential-helper
- `tests/` — smoke tests; `workspace/` — mounted code dir

## Commands

- Tests: `npm test` (supervisor + log-proxy + metrics + bridge + editor-extension + vsix packaging + git-sign + web + api smoke tests)
- VSIX: `bash bridge/editor-extension/build-vsix.sh` (vendors `bridge-api.js`,
  strips the source-tree fallback require, emits `nexos-bridge-<ver>.vsix`)
- CLI smoke: `bin/nexos status`, `bin/nexos exec "node -v"`
- Docker build: `docker build -t nexos .`
- Docker run: `docker run -p 4444:4444 -p 7681:7681 -p 7682:7682 -v "$PWD/workspace:/workspace" nexos`

## Environment caveat (this sandbox only)

The local dockerd is started manually with `--iptables=false --bridge=none`, so
there is **no bridge networking**: every `docker build`/`docker run` here must
pass `--network=host`, and container services bind host ports directly. Smoke
tests in this sandbox therefore use high ports (8444/9681/9682/9987) to avoid
colliding with host v0 services on 4444/7681/7682/9876. On a normal Docker
install the compose file / README port mapping applies as written.

## Gotchas / contracts

- **Supervisor liveness**: pidfile liveness is checked with `ps` command match
  (`grep -qF "$(basename "$0") run $name"`), NOT bare `kill -0` — survives
  PID-namespace reuse after host pause/resume.
- **Log-proxy exec**: children are `spawn`ed `detached:true` with file-backed
  stdio (never pipes) so user processes outlive proxy restarts; single shared
  100ms tail ticker; 50ms WS batching; 500-event history; `adminOnly` filter;
  non-loopback requests get 403. `child.on('error')` MUST resolve `wait:true`
  requests (a missing child has `pid === undefined`, so a `pid === null` guard
  hangs callers).
- **Shell under `set -u`**: do not nest parameter-expansion defaults inside an
  `eval` (e.g. `eval "flag=\${NEXOS_ENABLE_${f}:-\$NEXOS_ENABLE_ALL:-}"` blows
  up with "unbound variable"). Use indirect expansion `${!varname:-}` instead.
- **Test harness**: a bare `!` cannot be passed through `"$@"` in helper
  functions (e.g. `check "negation" ! kill ...`); use a separate `check_not`
  helper or `[ ! ... ]` test forms.
- **code-server install**: the npm package fails under npm 10/11 (nested vscode
  node_modules walker) — install from the GitHub release tarball
  (`code-server-<ver>-linux-<arch>.tar.gz`). Requires node >= 22 in the image.
- **ttyd**: Debian bookworm dropped the package — fetch the static binary from
  GitHub releases and verify its SHA256SUMS entry.
- **Bridge**: two deployments share the bridge port — `bridge/standalone.js`
  (filesystem handlers, supervised by default in the container) and
  `bridge/editor-extension/` (live editor handlers, loaded via
  `code-server --extensions-dir`). Run one or the other, never both.
- **VSIX packaging**: `build-vsix.sh` stages a copy of the extension, vendors
  `bridge-api.js` as `./bridge-api.js`, and strips the `../bridge-api` fallback
  from `extension.js`, so the VSIX is self-contained. vsce lowercases
  `README.md` → `readme.md` inside the package. Covered by `tests/vsix-smoke.sh`
  (builds, unzips, asserts no outside-package require, runs the packaged
  extension.js against a stubbed vscode).
- **`.dockerignore` globbing**: Docker uses Go `filepath.Match`, so a pattern
  without a `/` does NOT match files in subdirectories — `nexos-bridge-*.vsix`
  silently fails to exclude `bridge/editor-extension/*.vsix` from `COPY . .`.
  Use `**/*.vsix` (or a leading `**/`) for nested build artifacts.
- **Control-plane reachability**: loopback-only by default. `NEXOS_ALLOW_REMOTE=true`
  makes the log-proxy accept non-loopback clients and the bridge bind 0.0.0.0.
  Required when ports are published through Docker (docker-proxy arrives from a
  non-loopback address). Covered by smoke tests.
- **Control-plane auth**: `NEXOS_LOG_PROXY_TOKEN` / `NEXOS_BRIDGE_TOKEN` gate
  non-loopback requests with `Authorization: Bearer <token>` (or `?token=` for
  WS). Loopback is always trusted. Remote log-proxy clients without a token get
  401 and are forced non-admin. Covered by smoke tests.
- **Identity**: never commit `config/nexos.env`; it is generated by `nexos init`
  (and by the entrypoint) from `nexos.env.example`. `.gitignore` covers it.
  `metrics.sh` accepts `NEXOS_CALLBACK_*`, per-service `NEXOS_CODE_SERVER_CALLBACK_*`,
  and legacy `V0_*` names, in that preference order.
- **git-sign wire format**: the SSHSIG namespace and hashalg are serialized as
  plain RFC 4251 strings (NO trailing NUL) in both the signed message and the
  blob — this matches OpenSSH 8.7 (newer sshsig.c uses cstrings). Proven by
  byte-identical output vs `ssh-keygen -Y sign`. Never use `crypto.sign` against
  the raw blob; the tosign is `"SSHSIG" + s(ns) + s("") + s(alg) + s(H(data))`.
- **ssh-keygen -Y verify regression on AL2023**: this host's OpenSSH 8.7p1 +
  OpenSSL 3.5.5 rejects EVERY signature — including ssh-keygen's own — with
  "Signature verification failed: incorrect signature". Do not treat that tool
  as an oracle here; `tests/verify-sshsig.mjs` is the reference verifier, and
  `tests/sign-server-smoke.sh` probes the tool once and only runs tool-backed
  checks when it is healthy.
- **git-sign service**: `NEXOS_GIT_SIGN_KEY` (or `NEXOS_GIT_SIGN_KEY_PEM`) is
  required to start; `nexos sign-keygen [dir]` emits PKCS#8 PEM + OpenSSH pub.
  Token gate: non-loopback requests need `Authorization: Bearer $NEXOS_GIT_SIGN_TOKEN`;
  loopback always trusted. `NEXOS_GIT_SIGN_ALLOW_REMOTE`/`NEXOS_ALLOW_REMOTE=true`
  binds 0.0.0.0. The entrypoint skips git-sign unless a key is configured.
- **Web portal**: `web/api-server.js` is a plain `node:http` server (no deps, no
  build step) supervised as the `web` service (`NEXOS_WEB_PORT`, 8080;
  `NEXOS_WEB_HOST` defaults to 127.0.0.1, `0.0.0.0` when `NEXOS_ALLOW_REMOTE=true`).
  `/api/v1/login` + `/api/v1/logout` MUST stay registered BEFORE the auth gate in
  the router (they return 401 otherwise). Loopback is always trusted; remote needs
  `Authorization: Bearer $NEXOS_WEB_TOKEN` or a `nexos_session` cookie (HMAC-SHA256
  over expiry, base64url, 12h TTL). Settings persist atomically (tmp + rename) to
  `NEXOS_WEB_STATE_FILE` with a 40ms write debounce and a flush on SIGINT/SIGTERM.
  `/api/v1/exec` + `/api/v1/logs` proxy the log-proxy loopback; exec uses a 120s
  timeout. The dashboard (`web/index.html`) gains an Assistant panel: it streams
  the gateway's envelope routes via `POST /api/v1/chat/stream` (`{message,
  chatId?}` → create or continue) and `POST /api/v1/chat/resume` (`{chatId}`),
  which `proxyStream()` forwards verbatim to `NEXOS_API_PORT` (8081) SSE —
  frames are `event: update` `{status,event,chat,parts}` + a trailing `done`, so
  the client renders `payload.parts` text and never sees the raw API token. The
  panel renders via `web/chat-chunks.mjs` — a dependency-free port of
  `@v0-sdk/react` `chat/chunks.ts` (`V0SnapshotChunkReducer`) that reduces each
  envelope snapshot into incremental chunks (text/reasoning start-delta-end +
  `data-v0-<type>` action rows) — served as a whitelisted static asset
  (`GET /chat-chunks.mjs`, `text/javascript`), loaded by the dashboard with a
  dynamic `import()`, and unit-tested by `tests/web-chat-chunks.mjs` (9
  checks). The `/health` dependency probe includes `api`; `tests/web-smoke.sh`
  boots a live gateway (port 9997, loopback) and checks the proxy round-trip +
  the renderer asset + 400/404 error forwarding. When testing with curl,
  `Content-Type` equality checks must account for `charset` (e.g. `text/html;
  charset=utf-8`).
- **API gateway**: `api/api-server.mjs` is a plain `node:http` ESM server
  supervised as the `api` service (`NEXOS_API_PORT`, 8081) implementing the
  v0.app **API v2** contract under `/v2`. The route table is derived at startup
  from `api/openapi-v2.json` (checked-in copy of `vercel/v0-sdk`'s
  `openapi.json`, Apache-2.0) — never hand-edit a route list, regenerate from the
  spec. Order matters when matching: `GET /v2/chats/stream` is `chats.createStream`
  (POST-only), but `DELETE /v2/chats/stream` matches the parameterized
  `DELETE /chats/{chatId}` (it's a delete of chat id "stream") — expect that
  ambiguity, don't "fix" it. Errors use the v2 `Error` shape `{message}`; known
  but unimplemented operations return `501 {"message":"not_implemented:<op>"}`.
  Auth mirrors the portal: loopback trusted, `NEXOS_API_TOKEN` bearer for remote.
  State persists to `NEXOS_API_STATE_DIR` (default `state/api/`): `chats/<id>.json`,
  `files/<id>.json`, `workspace/<chatId>/` (from-zip/repo extraction), plus
  `mcp-servers.json`, `webhooks.json`, `preview-hosts.json` and
  `webhook-deliveries.jsonl` (Phase 3). Phase 3 — streaming + CRUD + previews +
  MCP + webhooks are live: `chats.createStream`,   `messages.sendStream`
  and `chats.resume` emit the raw `ChatStreamEvent`/`MessageStreamEvent` wire
  format on a deterministic mock backend; the full chat/message CRUD matrix
  (create/list/get/update/delete/duplicate, async variants, restore-message,
  from-files/zip/repo, getFiles/updateFiles) is implemented against the
  persistent store (`api/lib/{chat-store,chat-handlers,from}.mjs`).
  `chats.downloadFiles` streams a dependency-free stored ZIP of the chat's
  files (`api/lib/zip.mjs`; no external zip lib — entry CRC32, UTF-8 flag,
  POSIX modes, base64/utf8 content); `chats.getConnectStatus` reads
  `state/api/connectors.json` keyed by `requestId` and returns the spec's
  `pending|ready|error` oneOf, defaulting to `error: vercel_connect_not_configured`
  unless a record is seeded via `setConnectorStatus()` or a hand-written file. Phase 3 adds
  `chats.getPreview` (HMAC-signed chat-scoped token, 30 min TTL,
  `NEXOS_API_PREVIEW_SECRET`; `null` while the chat has no files), a preview
  ingress on `NEXOS_PREVIEW_PORT` (8082) ported from the SDK's `preview-proxy.ts`
  in `api/lib/preview.mjs` (origin-isolated; strips hop-by-hop + `x-vercel-*`/
  `x-forwarded-*`/`x-envoy-*`; pins `Cache-Control: private, no-store`;
  `x-v0-preview-refresh: 1` → `/_loading` fallback; default upstream is a mock
  static server over the chat's ingested files, override with
  `NEXOS_PREVIEW_UPSTREAM`), `mcp-servers` + `hooks` CRUD persisted via
  `api/lib/meta-store.mjs`, a webhook delivery loop in `api/lib/webhooks.mjs`
  (events `chat.created|chat.updated|chat.deleted|message.finished`, chat-scoped
  hooks via `chatId`, 3 attempts w/ backoff, delivery log), and
  `settings.preview-hosts` GET/PUT. Consumers are
  `tests/api-stream-sdk.mjs` (real `v0` npm SDK, devDependency only) +
  `tests/api-crud-smoke.sh` + `tests/api-meta-smoke.sh` (MCP/webhooks/settings,
  incl. delivery + chat-scoped filtering) + `tests/api-preview-smoke.sh`
  (getPreview + ingress).
  `api/lib/diffpatch.mjs` + `api/lib/v0-stream.mjs` are ports of the SDK's
  `stream/{diffpatch,result}.ts` — the v0 append fast-path `[[idx,...,suffix],9,9]`
  only fires for array-item-level string appends (integer-only paths);
  `parts[i].text` growth travels as plain jsondiffpatch deltas. The
  `messages.resolve` family (sync, async, stream) is implemented in
  `api/lib/mock-generator.mjs` (`validateTask`, `mockResolve`,
  `RESOLVE_TASK_TYPES`) with handlers in `chat-handlers.mjs` /
  `stream-handlers.mjs` — task types `confirmed-steps`,
  `plan-exit-response` (status `approved|rejected|request-changes`),
  `answered-questions`, `confirmed-permissions`, `vercel-connect-setup`;
  sync returns the follow-up Message (200), async returns
  `AsyncMessage {messageId}` (202), stream emits `MessageStreamEvent`
  frames (opening snapshot → `message.parts.chunk` deltas → `message.usage`
  → closing snapshot) and fires the `message.finished` webhook. The real SDK
  `client.messages.resolve` returns hey-api `{data,error,request,response}`
  and takes a flat `{chatId, task, modelConfiguration}` params object (NOT
  positional args). The final Vercel-only ops `chats.createVercelProject`
  (201 `{vercelProjectId}`) and `chats.deploy` (200
  `{deploymentId, vercelProjectId}`) have local equivalents: `projects.json`
  / `deployments.json` collections via `openCollection`, the chat is linked
  through `store.linkProject` (`chat.vercelProjectId`, listed/filtered by
  `chats.list`), deploy auto-creates a project when the chat has none and its
  `url` resolves to the preview ingress (`NEXOS_PREVIEW_URL`, default
  `http://127.0.0.1:8082/<chatId>`). Every operation in openapi-v2.json is
  now implemented (no 501s).

## Verification flow

1. `npm test`
2. If touching Docker: build with `--network=host`, run on high ports, check
   `docker logs` for the "NexOS ready" banner, curl each service, test
   `/execute` + `/history`, then `docker stop` and confirm the entrypoint
   "shutting down services..." path with no leaked supervisors on the host.
   `tests/web-smoke.sh` exercises the web layer outside Docker; the container
   runtime check curls `/health`, the dashboard, `/api/v1/exec` round-trip,
   `/api/v1/git-sign` on the mapped ports, and the v2 E2E (create a
   from-files chat → `chats.getPreview` → load the token URL through the
   preview ingress → 200, bad token → 403), then `docker rm -f` the container
   and confirm no leaked listeners on the host. Note the sandbox's host v0
   services already own 4444/7681/7682/9876 — the container's editor/terminal/
   log-proxy/bridge collide and fail to bind here; the api/web/preview
   (8080/8081/8082) are the reachable ones.
