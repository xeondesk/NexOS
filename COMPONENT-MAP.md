# NexOS — component migration map

Source: Vercel v0 sandbox platform (analyzed via `/vercel/share/*`).
Scope note: `/vercel/share/v0-project/` is excluded by instruction.

## Migrated components

| # | Source | NexOS target | Notes / changes |
|---|---|---|---|
| 1 | `/vercel/share/v0-supervise.sh` | `lib/supervisor.sh` | Core logic preserved verbatim. Hardcoded `/vercel/share/{logs,run}` → `NEXOS_ROOT/state/{logs,run}` (overridable via `NEXOS_SUPERVISE_LOG_DIR/RUN_DIR`). Env override prefix `V0_SUPERVISE_*` → `NEXOS_SUPERVISE_*`. Log tag `v0-supervise` → `nexos-supervise` (must match the script name the liveness grep looks for). |
| 2 | `/vercel/share/v0-log-proxy.js` | `lib/log-proxy.js` | Behavior contract preserved: localhost-only API, detached file-backed exec, single-ticker tails, 50ms batching, 500-event history, `adminOnly` filtering. `LOG_PROXY_PORT` → `NEXOS_LOG_PROXY_PORT` (7682); exec log dir → `NEXOS_EXEC_LOG_DIR` (default `/tmp/nexos-exec-logs`); PTY flag `__V0_USE_PTY` → `__NEXOS_USE_PTY`; tags `[log-proxy]` → `[nexos:log-proxy]`. Depends on `ws` (declared in package.json). |
| 3 | `/vercel/share/v0-metrics.sh` | `lib/metrics.sh` | `ENV_FILE` → `NEXOS_ENV_FILE` (default `config/nexos.env`), legacy `/vercel/share/.env.project` kept as fallback. Vars read via `NEXOS_*` with `V0_*` legacy fallback. Added `--once` mode for testing. `[v0-metrics]` → `[nexos:metrics]`. |
| 4 | `/vercel/share/v0-runtime/register.mjs` | `lib/register.mjs` | Unchanged (pnpm-skip guard kept). |
| 5 | `/vercel/share/v0-runtime/config-loader.mjs` | `lib/config-loader.mjs` | v0 hostnames (`*.vusercontent.net`, `*.v0.build`, `*.vercel.run`) → NexOS defaults (`*.nexos.build`, `*.nexos.run`, `*.nexos.net`) plus `NEXOS_ALLOWED_DEV_HOSTS` (JSON) for extension. Passthrough query `?v0-passthrough` → `?nexos-passthrough`. |
| 6 | `/vercel/share/v0-code-server.sh` | `services/editor.sh` | `--bind-addr` from `NEXOS_EDITOR_PORT` (4444); config + user-data relocated under NexOS state dir; config file generated on first boot; workspace → `NEXOS_WORKSPACE`. |
| 7 | `/vercel/share/v0-ttyd.sh` | `services/terminal.sh` | `-p NEXOS_TERMINAL_PORT` (7681), `-w NEXOS_WORKSPACE`. Theme/UX flags unchanged. |
| 8 | `code-server v0-bridge` extension `api-server.js` | `bridge/bridge-api.js` | Rewritten from transpiled CJS to a clean standalone class (`NexOSBridgeApiServer`) with handler injection + `NEXOS_BRIDGE_PORT`/`NEXOS_BRIDGE_HOST`. Routes unchanged: `GET /status`, `POST /set-readonly`, `/reload-files`, `/set-workspace-name`. |
| 8a | — | `bridge/standalone.js` | New supervised bootstrap for the bridge: instantiates the server with filesystem-backed default handlers persisting to `state/run/` (`readonly`, `workspace-name`, `readonly-reasons.log`, `reload-requests.log`). Registered as built-in service `bridge` and started by the container entrypoint. |
| 8b | — | `bridge/editor-extension/` | New code-server extension reproducing the v0 live-editor bridge behavior: same transport, but handlers act on the open editor (`files.readonlyInclude` toggle, revert/reload of files, status-bar workspace label). Load via `code-server --extensions-dir` or install the `nexos-bridge-*.vsix` built by `build-vsix.sh` (vendored transport, self-contained; `tests/vsix-smoke.sh`). Use instead of the standalone bridge (they share the port). |

## Reachability (new config, no v0 source)

`NEXOS_ALLOW_REMOTE` (default `false`) lifts the loopback-only control-plane
policy for Docker port publishing: `lib/log-proxy.js` skips the 403 for
non-loopback clients and `bridge/standalone.js` / `bridge/editor-extension`
bind `0.0.0.0`. Covered by smoke tests.
| 9 | `/vercel/share/v0-git-ssh-sign` | `git/ssh-sign.sh` | Endpoint → `NEXOS_GIT_SIGN_URL` (default: legacy v0 signing service); namespace header name → `NEXOS_GIT_SIGN_NAMESPACE_HEADER`; bearer token via `NEXOS_GIT_SIGN_TOKEN`. Parsing/exit codes unchanged. |
| 10 | `/vercel/share/v0-git-ssh-allowed-signers` | `git/allowed-signers` | Reference file; principal renamed to the NexOS identity. |
| 11 | `/vercel/bin/git-credential-helper` | `git/credential-helper` | Reads `NEXOS_GIT_USERNAME/PASSWORD` (fallback `GIT_*`). |

## Packaging (new, no v0 source)

| File | Purpose | Notes |
|---|---|---|
| `Dockerfile` | Container image | `node:22-bookworm-slim` base; code-server installed from GitHub release tarball (npm package breaks under npm 10/11); ttyd fetched as a static binary and checksum-verified (Debian bookworm dropped it); runs unprivileged as `nexos` uid 2000; multi-arch via `TARGETARCH`; `HEALTHCHECK` polls the control plane. |
| `.dockerignore` | Build-context trim | Excludes state/logs, node_modules, `config/nexos.env`, compose file, test cruft. |
| `docker-compose.yml` | Declarative run | Ports 4444/7681/7682/9876/8080/8081, `./workspace:/workspace` + `nexos-state` volume, `NEXOS_ENABLE_*` gating comments, healthcheck. |
| `bin/entrypoint.sh` | PID-1 entrypoint | Sources `config/nexos.conf`, synthesizes `config/nexos.env` from the example if absent, starts each gated service via the supervisor, traps SIGTERM/SIGINT for clean shutdown. Metrics auto-skip unless a non-empty callback URL is configured; git-sign auto-skips without a signing key. |
| `web/api-server.js` | Web portal API server | Dependency-free (`node:http`) aggregation layer over the control plane: `/health` (auth flag + log-proxy/bridge/git-sign dependency state), `/api/v1/status` (supervised services via pidfile scan + `ps`), `/api/v1/logs` + `/api/v1/exec` (loopback proxies to the log-proxy, 120s exec timeout), `/api/v1/metrics` (/proc + `df`), `/api/v1/git-sign` + `/api/v1/bridge` (reachability + pubkey), `/api/v1/settings` GET/PUT (atomic tmp+rename JSON with 40ms debounce + flush on SIGTERM/SIGINT). Loopback always trusted; remote clients need `NEXOS_WEB_TOKEN` bearer or an HMAC-SHA256 session cookie (12h TTL); login/logout routes sit before the auth gate. |
| `web/index.html` | Web dashboard | Static dark-mode SPA served by `api-server.js` (no build step): services table, metrics grid, git-sign panel, auto-refreshing log viewer, exec console, settings form, login overlay. |
| `api/api-server.mjs` | v0-compatible API gateway | Dependency-free (`node:http`) gateway for the v0.app production **API v2** contract (`https://api.v0.dev/v2`), served under `/v2`. Route table derived at startup from `api/openapi-v2.json` (copy of `vercel/v0-sdk`'s `openapi.json`, Apache-2.0) → all 41 operations registered, contract validation (422 / `{message}` errors), bearer auth (`NEXOS_API_TOKEN`) + loopback trust. Phase 0 = routing/auth/validation skeleton; Phase 1 = streaming (`chats.createStream`, `messages.sendStream`, `chats.resume`) emitting the raw ChatStreamEvent/MessageStreamEvent SSE wire format from a deterministic mock backend, round-trip tested against the real `v0` SDK. Phase 2 = chat/message CRUD + persistence (create/list/get/update/delete/duplicate, async variants, restore-message, from-files/zip/repo, getFiles/updateFiles) via `api/lib/chat-handlers.mjs` + persistent `api/lib/chat-store.mjs` under `NEXOS_API_STATE_DIR`. Phase 3 = previews + MCP + webhooks: `chats.getPreview`, a preview ingress on `NEXOS_PREVIEW_PORT` (`api/lib/preview.mjs`), `mcp-servers` + `hooks` CRUD + webhook delivery loop (`api/lib/meta-handlers.mjs`, `api/lib/meta-store.mjs`, `api/lib/webhooks.mjs`), `settings.preview-hosts` — see `analysis/v0-sdk-analysis.md`. |
| `api/openapi-v2.json` | v2 API contract | Checked-in copy of `packages/v0-sdk/openapi.json` (v0 API 2.0.0, OpenAPI 3.1) — source of truth for the gateway's route table. |
| `api/lib/diffpatch.mjs` | v0 delta wire format | Port of `v0-sdk` `stream/diffpatch.ts`: `jsondiffpatch` deltas + the v0 append fast-path `[[idx,...,suffix],9,9]` (Apache-2.0, `jsondiffpatch` runtime dep). |
| `api/lib/v0-stream.mjs` | v0 stream machinery | Port of `v0-sdk` `stream/result.ts`: `applyStreamEvent` accumulation, `SharedV0StreamResult` fan-out, `createV0StreamResult`/`readV0Stream`, SSE `formatSse`/parse (Apache-2.0). |
| `api/lib/chat-store.mjs` | Chat/message store | Persistent JSON store under `NEXOS_API_STATE_DIR` (default `state/api/`): `chats/<chatId>.json` (chat + messages), `files/<chatId>.json`, atomic tmp+rename writes on every mutation. Full API: create/update/delete/duplicate chat, add/get/list messages with cursor pagination, markRestorable, files get/set. |
| `api/lib/chat-handlers.mjs` | CRUD handlers | JSON request handlers for the Phase 2 operation set (create/list/get/update/delete/duplicate, async, restore-message, from-files/zip/repo, getFiles/updateFiles, message list/send/get/stop); mock assistant responses, from-* handlers roll back the chat on failure. |
| `api/lib/from.mjs` | Source ingestion | from-files normalization, from-zip (fetch + unzip, `-Z1` listing), from-repo (`git clone --depth 1` + `ls-files -z`); `toFilesRecord` skips vendored/binary/large paths. |
| `api/lib/stream-handlers.mjs` | Streaming ops | `chats.createStream` / `messages.sendStream` / `chats.resume` SSE handlers over the mock backend; emits `chat.created` / `message.finished` webhook events. |
| `api/lib/mock-generator.mjs` | Mock backend | Deterministic title + parts progression (append-only text) powering the stream events. |
| `api/lib/preview.mjs` | Preview ingress | Port of `v0-sdk` `preview-proxy.ts`: HMAC-SHA256 chat-scoped preview tokens (`NEXOS_API_PREVIEW_SECRET`, 30 min TTL), origin-isolated forwarding with header stripping + `Cache-Control: private, no-store` pinning, `x-v0-preview-refresh: 1` → `/_loading` fallback, and a built-in mock upstream serving the chat's ingested files (override via `NEXOS_PREVIEW_UPSTREAM`). |
| `api/lib/meta-store.mjs` | Meta collections | Generic persisted collection (open/create/update/remove/list) for `mcp-servers`, `webhooks`, `preview-hosts` + JSONL append log for webhook deliveries. |
| `api/lib/meta-handlers.mjs` | Meta handlers | `mcpServers.*` / `webhooks.*` CRUD (events validated, `{id,deleted:true}` / `{success:true}` deletes), `settings.getPreviewHosts`/`setPreviewHosts`, `chats.getPreview` (404 unknown chat, `null` without files). |
| `api/lib/webhooks.mjs` | Webhook delivery | `emitWebhookEvent` fan-out to subscribed (chat-scoped) hooks; fire-and-forget POST with 3 attempts + exponential backoff, `x-nexos-webhook-delivery`/`x-nexos-webhook-event` headers, `state/api/webhook-deliveries.jsonl` log. |
| `api/lib/chat-store.mjs` | Chat/message store | In-memory chat/message records (Phase 1; durable persistence in Phase 2). |
| `git/sign-server.js` | Self-hosted git-sign service | Reference replacement for the legacy v0 git-sign endpoint: `GET /health`, `GET /pubkey`, `POST /sign` (raw payload, namespace in `x-v0-git-signing-namespace` header, SHA-256/SHA-512). Ed25519 key via `nexos sign-keygen`. SSHSIG output byte-identical to `ssh-keygen -Y sign`; verified by `tests/verify-sshsig.mjs` + `tests/sign-server-smoke.sh`. |

## Not migrated (platform-owned / not reusable)

| Source | Reason |
|---|---|
| `/opt/vercel/sandbox-init`, `/run/vercel/share/sandbox-init` | Vercel host bootstrap (PID 1, init socket, pubkey auth) — infrastructure-owned, no standalone value. |
| `/vercel/share/v0-supervise.sh` pm2 legacy handling | Kept in supervisor but conditional; pm2 is a host legacy, not a NexOS dependency. |
| `/vercel/share/.env.project` (OIDC token, callbacks) | Runtime identity — replaced by `config/nexos.env` template; secrets never committed. |
| `vercel.vercel-theme` / language extensions | Editor-distribution assets, not system components. |
| `23456` / `30001–30010` listeners | Kernel/netns sandbox-infra forwarding ports; no userspace component to extract. |

## Behavioral contracts preserved

1. **Supervisor** — pidfile liveness is verified by `ps` command match (survives PID-namespace reuse on host resume); stop/restart kill the whole process group (TERM → escalation → KILL) so ports are released before respawn; flock on fd 9 with `9>&-` closed at spawn to avoid self-deadlock.
2. **Log-proxy exec** — children are `detached` and stdio is file-backed (never pipes), so user processes outlive proxy restarts; tails are shared on one ticker; 10MB truncate + 64KB read caps bound memory/disk.
3. **Metrics** — payload shape `{type:"metrics_report",metrics:{memTotalMB,...cpuUsagePercent}}` is unchanged so existing control planes keep working.
