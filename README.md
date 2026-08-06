# NexOS

NexOS is a self-hosted development-environment orchestration system, migrated
out of a Vercel v0 sandbox so the reusable control-plane components can live
on independently. It supervises editor/terminal services, streams logs, runs
commands through a localhost control plane, reports resource metrics, injects
framework runtime hooks, and provides git identity helpers.

## Layout

```
nexos/
├── bin/nexos             CLI front door (start/stop/status/exec/init)
├── config/
│   ├── nexos.conf        all paths/ports/env defaults (NEXOS_* overrides)
│   └── nexos.env.example callback identity template
├── lib/
│   ├── supervisor.sh     per-service process supervisor (pm2 replacement)
│   ├── log-proxy.js      WS log streaming + local exec control plane
│   ├── metrics.sh        resource metrics daemon (60s → callback)
│   ├── register.mjs      Node module-hook registration (framework runtime)
│   └── config-loader.mjs next.config.* interception + NexOS overrides
├── services/
│   ├── editor.sh         code-server (VS Code web) on NEXOS_EDITOR_PORT
│   └── terminal.sh       ttyd web terminal on NEXOS_TERMINAL_PORT
├── bridge/
│   ├── bridge-api.js     standalone localhost control API for editor hosts
│   └── standalone.js     supervised bridge service (filesystem-backed handlers)
├── git/
│   ├── ssh-sign.sh       ssh-keygen -Y sign proxy → hosted signing service
│   ├── allowed-signers   trusted signing keys
│   └── credential-helper git credential fill helper
├── state/                runtime: logs/, run/ (pidfiles + locks)
└── tests/                supervisor / log-proxy / metrics smoke tests
```

## Quick start

```sh
nexos init                 # state dirs, config/nexos.env, npm install
nexos start log-proxy      # control plane on NEXOS_LOG_PROXY_PORT (7682)
nexos start terminal       # web terminal on NEXOS_TERMINAL_PORT (7681)
nexos start editor         # VS Code web on NEXOS_EDITOR_PORT (4444)
nexos start metrics        # metrics daemon
nexos start bridge         # control API for editor hosts (NEXOS_BRIDGE_PORT, 9876)
nexos status
nexos exec "node -v"       # run through the control plane, logs streamed
nexos stop editor
```

Every service is supervised: crashes auto-restart with exponential backoff,
stop/restart use group-kill with escalation, and pidfiles stay valid across
host pause/resume (liveness is verified against the process table, not a bare
`kill -0`).

## Control plane

The log-proxy exposes a **localhost-only** HTTP + WebSocket API:

| Endpoint | Method | Purpose |
|---|---|---|
| `/health` | GET | liveness + connected client count |
| `/history?since=&isAdmin=` | GET | last 500 log events (ring buffer) |
| `/execute` | POST | run `{cmd,args,cwd,env,wait,blockId}`; `env.__NEXOS_USE_PTY` selects PTY mode |
| `/clear` | POST | reset history |
| `/log` | POST | inject a log line (optional `adminOnly`) |

Non-loopback requests are rejected with 403. Child processes are detached
(own process group), write stdio to files that are tailed (single shared
ticker), and are therefore immune to log-proxy restarts.

## Configuration

Everything is overridable via `NEXOS_*` env vars (see `config/nexos.conf`):
ports, state dirs, workspace, callback identity, allowed dev hosts for the
framework hooks, and the git signing endpoint.

The framework hooks (`lib/register.mjs` + `lib/config-loader.mjs`) intercept
`next.config.*` to force `allowedDevOrigins`, `serverActions.allowedOrigins`,
dev-mode `images.unoptimized`, and Turbopack persistent-cache control. Point
`NODE_OPTIONS="--import $NEXOS_ROOT/lib/register.mjs"` at the framework
process. Registration is skipped inside pnpm processes (pnpm 11 otherwise
fails on a missing `.pnpmfile.mjs`).

## Tests

```sh
npm test   # supervisor + log-proxy + metrics + bridge smoke tests
```

## Docker

The whole environment ships as a container image — `node:22-bookworm-slim`,
code-server 4.117.0 (GitHub release tarball), ttyd 1.7.7 (static GitHub
release, verified by checksum; Debian dropped the package), git, python3, and
runs unprivileged as the `nexos` user (uid 2000). `amd64` and `arm64` builds
are supported via the `TARGETARCH` build arg.

```sh
docker compose up -d
# open http://localhost:4444 (VS Code web) and http://localhost:7681 (terminal)

# or manually:
docker build -t nexos .
docker run --rm -p 4444:4444 -p 7681:7681 -p 7682:7682 \
  -v "$PWD/workspace:/workspace" nexos
```

- `/workspace` is the mounted code directory; `nexos-state` volume persists
  logs, pidfiles, and editor config.
- Ports: `4444` editor, `7681` terminal, `7682` log-proxy, `9876` bridge API
  (localhost-only by default).
- Service gating via `NEXOS_ENABLE_*` (`log-proxy`, `editor`, `terminal`,
  `metrics`, `bridge`). Editor/terminal auto-skip if the binary is absent;
  metrics auto-skip until a callback URL is configured (`NEXOS_CALLBACK_URL` or a
  mounted `config/nexos.env`).
- The entrypoint (`bin/entrypoint.sh`) starts all services, traps
  `SIGTERM`/`SIGINT`, and shuts every supervised service down cleanly.
- `HEALTHCHECK` polls `:7682/health`.

## Bridge API

The standalone bridge (`bridge/standalone.js`) is supervised like any other
service and exposes the same routes as the original editor-host API:
`GET /status`, `POST /set-readonly`, `/reload-files`, `/set-workspace-name`.
Without a code-server extension host it uses filesystem-backed handlers that
persist state under the NexOS run dir (`state/run/`): `readonly`,
`workspace-name`, `readonly-reasons.log`, `reload-requests.log`.

## Migration

See [COMPONENT-MAP.md](./COMPONENT-MAP.md) for the source-to-NexOS mapping of
every migrated component.
