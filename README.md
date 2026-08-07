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
│   ├── sign-server.js    reference git-sign service (ed25519, token-gated)
│   ├── sign-keygen.js    git-sign keypair generator (nexos sign-keygen)
│   ├── allowed-signers   trusted signing keys
│   └── credential-helper git credential fill helper
├── web/
│   ├── api-server.js     web portal API server (auth, status, logs, exec, metrics)
│   └── index.html        dependency-free dark dashboard (consumes /api/v1)
├── api/
│   ├── api-server.mjs    v0-compatible API gateway (v2 contract, routes from spec)
│   └── openapi-v2.json   v0.app production API v2 contract (vercel/v0-sdk)
├── state/                runtime: logs/, run/ (pidfiles + locks)
└── tests/                supervisor / log-proxy / metrics / git-sign / web / api smoke tests
```

## Quick start

```sh
nexos init                 # state dirs, config/nexos.env, npm install
nexos start log-proxy      # control plane on NEXOS_LOG_PROXY_PORT (7682)
nexos start terminal       # web terminal on NEXOS_TERMINAL_PORT (7681)
nexos start editor         # VS Code web on NEXOS_EDITOR_PORT (4444)
nexos start metrics        # metrics daemon
nexos start bridge         # control API for editor hosts (NEXOS_BRIDGE_PORT, 9876)
nexos start web            # full-platform web portal on NEXOS_WEB_PORT (8080)
nexos start api            # v0-compatible API gateway on NEXOS_API_PORT (8081)
nexos sign-keygen          # git-sign keypair (state/sign/sign-key.{pem,pub})
nexos start git-sign       # self-hosted SSH signing service (NEXOS_GIT_SIGN_PORT, 9877)
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

Control-plane reachability is strict loopback-only by default (log-proxy
returns 403 for non-loopback clients, bridge binds 127.0.0.1). When services
are published through Docker port mapping the connection arrives from a
non-loopback address, so set `NEXOS_ALLOW_REMOTE=true` to serve it (see the
commented example in `docker-compose.yml`).

**Control-plane auth:** set `NEXOS_LOG_PROXY_TOKEN` and/or `NEXOS_BRIDGE_TOKEN`
to require a bearer token from remote clients (`Authorization: Bearer <token>`).
Loopback requests stay token-free and remain trusted. Remote clients without a
valid token get `401`, and (for the log-proxy) are treated as non-admin — they
cannot see `adminOnly` log lines, which also means a token-authed client is
required to read those lines remotely.

## Web portal

`nexos start web` runs a dependency-free web dashboard (`web/api-server.js`,
plain `node:http`) that aggregates the whole control plane behind one port:

| Route | Method | Purpose |
|---|---|---|
| `/` | GET | dashboard (`web/index.html`) |
| `/health` | GET | liveness + auth flag + log-proxy/bridge/git-sign dependency state |
| `/api/v1/status` | GET | supervised service states (pidfile scan + `ps` match) |
| `/api/v1/logs` | GET | log-proxy history (proxied) |
| `/api/v1/exec` | POST | run `{cmd,args,...}` through the log-proxy (120s timeout) |
| `/api/v1/metrics` | GET | `/proc` memory/CPU/load + `df` usage |
| `/api/v1/git-sign` | GET | git-sign service reachability + public key |
| `/api/v1/bridge` | GET | bridge status |
| `/api/v1/settings` | GET/PUT | persisted settings (`NEXOS_WEB_STATE_FILE`, atomic write + debounce) |
| `/api/v1/login` | POST | exchange token for session cookie |
| `/api/v1/logout` | POST | clear session cookie |

Loopback traffic is always trusted; remote clients must send
`Authorization: Bearer $NEXOS_WEB_TOKEN` or a `nexos_session` cookie (HMAC-
SHA256 over the expiry, 12h TTL, HttpOnly/SameSite=Lax). Set
`NEXOS_WEB_TOKEN` to enable auth — unset, the portal is open (loopback-only by
default via `NEXOS_WEB_HOST=127.0.0.1`; serve `0.0.0.0` with
`NEXOS_ALLOW_REMOTE=true`). The dashboard (`web/index.html`) has no build
step or framework dependency and is served by the API server itself.

## v0-compatible API gateway

`nexos start api` runs a dependency-free `node:http` gateway
(`api/api-server.mjs`) implementing the **v0.app production API v2 contract**
(`https://api.v0.dev/v2`), served under `/v2`. The route table is derived at
startup from `api/openapi-v2.json` — a copy of the spec shipped with
`vercel/v0-sdk` (Apache-2.0) — so the mounted surface (all 41 operations:
chats, messages, MCP servers, previews, webhooks) can never drift from the
contract. Connect the real SDK with `createV0Client({ baseUrl:
'http://127.0.0.1:8081/v2', auth })`.

This is a phased effort: Phase 0 ships the routing/auth/validation skeleton
(known operations dispatch and validate, unimplemented handlers return `501`),
with the streaming wire format, chat/message CRUD, previews, MCP servers and
webhooks landing in later phases (see `analysis/v0-sdk-analysis.md`).

Auth mirrors the portal: loopback always trusted, `NEXOS_API_TOKEN` required as
`Authorization: Bearer <token>` from non-loopback clients (which is exactly how
the SDK authenticates). Error responses use the v2 `Error` shape `{ message }`.

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

## Git identity

NexOS ships three git helpers under `git/`; wire them per your provider:

- **GitHub (HTTPS)** — delegate to the GitHub CLI so tokens never touch disk:
  ```
  git config --global credential.helper ''
  git config --global --add credential.https://github.com.helper '!gh auth git-credential'
  ```
- **GitHub (SSH-signed commits)** — route `ssh-keygen -Y sign` to a hosted
  signing service so signing keys never live on the host:
  ```
  git config --global gpg.format ssh
  git config --global user.signingkey <key>
  git config --global gpg.ssh.program $NEXOS_ROOT/git/ssh-sign.sh
  git config --global gpg.ssh.allowedSignersFile $NEXOS_ROOT/git/allowed-signers
  git config --global commit.gpgsign true
  ```
  `ssh-sign.sh` posts the payload to `NEXOS_GIT_SIGN_URL` (defaults to the legacy
  v0 endpoint). To sign with your own service instead, generate a keypair and
  point the endpoint at the bundled reference sign service:
  ```
  nexos sign-keygen            # writes state/sign/sign-key.{pem,pub}
  export NEXOS_GIT_SIGN_KEY=$NEXOS_ROOT/state/sign/sign-key.pem
  nexos start git-sign         # or run `nexos run git-sign`
  export NEXOS_GIT_SIGN_URL=http://127.0.0.1:9877/sign
  ```
  Add the public key line from `state/sign/sign-key.pub` (prefixed with a
  principal) to `git/allowed-signers`. Signatures are namespace-bound and
  SHA-512; set a `NEXOS_GIT_SIGN_TOKEN` to gate remote clients with a bearer
  token.
- **Generic (HTTPS basic auth)** — set `NEXOS_GIT_USERNAME` / `NEXOS_GIT_PASSWORD`
  and install the helper:
  ```
  git config --global credential.helper $NEXOS_ROOT/git/credential-helper
  ```

## Tests

```sh
npm test   # supervisor + log-proxy + metrics + bridge + extension + git-sign + web + api smoke tests
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
# or the aggregated dashboard at http://localhost:8080 (web portal)

# or manually:
docker build -t nexos .
docker run --rm -p 4444:4444 -p 7681:7681 -p 7682:7682 \
  -v "$PWD/workspace:/workspace" nexos
```

- `/workspace` is the mounted code directory; `nexos-state` volume persists
  logs, pidfiles, and editor config.
- Ports: `4444` editor, `7681` terminal, `7682` log-proxy, `9876` bridge API
  (localhost-only by default), `8080` web portal (`NEXOS_WEB_PORT`), `8081` v2
  API gateway (`NEXOS_API_PORT`).
- Service gating via `NEXOS_ENABLE_*` (`log-proxy`, `editor`, `terminal`,
  `metrics`, `bridge`, `web`, `api`). Editor/terminal auto-skip if the binary is
  absent; metrics auto-skip until a callback URL is configured
  (`NEXOS_CALLBACK_URL` or a mounted `config/nexos.env`).
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

For **live editor coupling** (the v0 behavior — mutating the open editor
instead of state files), run the bundled code-server extension instead of the
standalone service (pick one; they share the bridge port):

```sh
code-server --extensions-dir $NEXOS_ROOT/bridge/editor-extension \
  --bind-addr 0.0.0.0:${NEXOS_EDITOR_PORT} --user-data-dir ... --config ... \
  "$NEXOS_WORKSPACE"
```

The extension (`bridge/editor-extension/extension.js`) starts the same
`NexOSBridgeApiServer` transport with live handlers: `set-readonly` toggles
`files.readonlyInclude` in the workspace, `reload-files` reverts matching open
editors (or reloads the window), and `set-workspace-name` updates the
status-bar label. It reads `NEXOS_BRIDGE_PORT` / `NEXOS_BRIDGE_HOST` /
`NEXOS_ALLOW_REMOTE` from the code-server process environment.

The extension also ships as an installable, self-contained VSIX:

```sh
bash bridge/editor-extension/build-vsix.sh
code-server --install-extension bridge/editor-extension/nexos-bridge-0.1.0.vsix
```

The build vendors `bridge-api.js` into the package and strips the source-tree
fallback require, so the VSIX has no host-path assumptions
(`tests/vsix-smoke.sh` verifies this).

## Migration

See [COMPONENT-MAP.md](./COMPONENT-MAP.md) for the source-to-NexOS mapping of
every migrated component.
