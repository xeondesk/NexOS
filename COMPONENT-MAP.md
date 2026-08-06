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
| 9 | `/vercel/share/v0-git-ssh-sign` | `git/ssh-sign.sh` | Endpoint → `NEXOS_GIT_SIGN_URL` (default: legacy v0 signing service); namespace header name → `NEXOS_GIT_SIGN_NAMESPACE_HEADER`. Parsing/exit codes unchanged. |
| 10 | `/vercel/share/v0-git-ssh-allowed-signers` | `git/allowed-signers` | Reference file; principal renamed to the NexOS identity. |
| 11 | `/vercel/bin/git-credential-helper` | `git/credential-helper` | Reads `NEXOS_GIT_USERNAME/PASSWORD` (fallback `GIT_*`). |

## Packaging (new, no v0 source)

| File | Purpose | Notes |
|---|---|---|
| `Dockerfile` | Container image | `node:22-bookworm-slim` base; code-server installed from GitHub release tarball (npm package breaks under npm 10/11); ttyd fetched as a static binary and checksum-verified (Debian bookworm dropped it); runs unprivileged as `nexos` uid 2000; multi-arch via `TARGETARCH`; `HEALTHCHECK` polls the control plane. |
| `.dockerignore` | Build-context trim | Excludes state/logs, node_modules, `config/nexos.env`, compose file, test cruft. |
| `docker-compose.yml` | Declarative run | Ports 4444/7681/7682/9876, `./workspace:/workspace` + `nexos-state` volume, `NEXOS_ENABLE_*` gating comments, healthcheck. |
| `bin/entrypoint.sh` | PID-1 entrypoint | Sources `config/nexos.conf`, synthesizes `config/nexos.env` from the example if absent, starts each gated service via the supervisor, traps SIGTERM/SIGINT for clean shutdown. Metrics auto-skip unless a non-empty callback URL is configured. |

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
