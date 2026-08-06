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
- `git/` — ssh-sign.sh, allowed-signers, credential-helper
- `tests/` — smoke tests; `workspace/` — mounted code dir

## Commands

- Tests: `npm test` (supervisor + log-proxy + metrics + bridge + editor-extension + vsix packaging smoke tests)
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

## Verification flow

1. `npm test`
2. If touching Docker: build with `--network=host`, run on high ports, check
   `docker logs` for the "NexOS ready" banner, curl each service, test
   `/execute` + `/history`, then `docker stop` and confirm the entrypoint
   "shutting down services..." path with no leaked supervisors on the host.
