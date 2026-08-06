# NexOS Migration Report — AI Agent Analysis of the Vercel v0 Platform

**Scope:** comprehensive, AI-agent-driven analysis of the entire current system
to identify, isolate, and migrate its reusable features into a self-hosted
system (NexOS), parameterized so it can operate outside the host platform.

**Date:** 2026-08-06 · **Host:** `a2634284-724` (Amazon Linux 2023, kernel
6.18.40, x86_64) · **Excluded by instruction:** `/vercel/share/v0-project/`.

---

## 1. Executive summary

The Vercel v0 sandbox is not a bare VM — it is a layered platform whose
*runtime layer* is a small, self-contained orchestration stack that can be
lifted out almost verbatim:

- a **process supervisor** (`v0-supervise.sh`),
- a **control plane** that streams logs and executes commands (`v0-log-proxy.js`),
- an **editor** and **terminal** service pair (`v0-code-server.sh`, `v0-ttyd.sh`),
- a **telemetry/metrics** daemon (`v0-metrics.sh`),
- an **editor-bridge** API running inside the code-server extension host,
- **framework runtime hooks** that open the dev server to the AI agent's
  browser (`v0-runtime/`), and
- **git identity helpers** for signed commits without exposing keys.

Everything except the host-owned bootstrap (`sandbox-init`), the proxy
ingress, and the sample project is reusable. NexOS migrated all of it with the
behavioral contracts preserved (verified by an automated smoke suite), added a
container image + compose deployment, and documented the architecture gaps.

**AI features identified and migrated:** the agent-connection layer — dev-server
ingress hooks (`allowedDevOrigins`/`serverActions.allowedOrigins` injection),
the log/exec control plane (the agent's eyes and hands), the editor mutation
bridge, the callback channel, git signing, and resource metrics. Not migrated:
the platform's own AI credentials and the agent itself (out of scope).

---

## 2. Methodology — the AI migration system

The migration was executed as a systematic, AI-assisted pipeline. Each phase
was driven by agent analysis and verified by tests rather than guesswork.

### Phase 1 — Discovery
Catalog the entire running system: processes (`ps`), listeners (`ss`), mounts,
identity files, the `/vercel/share` tree, and every config path baked into the
component scripts. Output: a full inventory (Section 3).

### Phase 2 — Classification
For every component, answer three questions:
1. *Is it reusable logic, or host-infrastructure?*
2. *Does it contain hardcoded host paths/ports/credentials?*
3. *Is it in scope (i.e. not `v0-project`)?*

This produced the migrate / platform-owned / excluded triage (Section 4).

### Phase 3 — Isolation
For each reusable component, find every host-specific binding and replace it
with a parameterized `NEXOS_*` variable (defaults preserved so behavior is
byte-for-byte identical until overridden):
- paths: `/vercel/share/{logs,run}` → `$NEXOS_ROOT/state/{logs,run}`
- ports: `4444/7681/7682/9876` → `NEXOS_EDITOR_PORT/…`
- query tokens: `?v0-passthrough` → `?nexos-passthrough`
- dev-host allowlists: `*.vusercontent.net,*.v0.build,*.vercel.run` →
  `*.nexos.build,*.nexos.run,*.nexos.net` + `NEXOS_ALLOWED_DEV_HOSTS` (JSON)
- env prefixes: `V0_*` → `NEXOS_*` with legacy `V0_*` fallback retained
- identity: `/vercel/share/.env.project` → `config/nexos.env` (template;
  never committed)

### Phase 4 — Migration
Move the isolated logic into the NexOS layout, keeping each file a recognizable
descendant of its source so the provenance stays auditable (see COMPONENT-MAP.md).

### Phase 5 — Verification
Every migrated contract got a smoke test:
- supervisor lifecycle (idempotent start, restart, group-kill escalation,
  crash backoff),
- log-proxy (health, wait-exec, history, streaming, 403 guard, missing-binary
  resolution),
- metrics (payload shape, per-service callback preference, no-callback path),
- bridge (routes, validation, state persistence, loopback reachability),
- editor extension (live handler wiring under a stubbed `vscode`).

Plus an end-to-end container validation (build, run all services, exec round-trip,
graceful shutdown, no leaked processes).

### Phase 6 — Containerization
`Dockerfile` (node:22-bookworm-slim, code-server 4.117.0 tarball, ttyd 1.7.7
static binary with checksum, unprivileged `nexos` uid 2000, HEALTHCHECK),
`.dockerignore`, `docker-compose.yml`, and a signal-handling entrypoint.

---

## 3. System inventory (the entire current system)

### 3.1 Host platform
| Item | Detail |
|---|---|
| OS | Amazon Linux 2023, kernel 6.18.40, 4 vCPU / 8 GB, cgroup v2, overlay2 |
| PID 1 | `sandbox-init` (Vercel) — `/run/vercel/share/sandbox-init`, unix socket + pubkey auth; also copied at `/opt/vercel/share/sandbox-init` |
| Init system | none (systemctl binary present, zero units) |
| Networking | `eth0 100.64.78.190/16` (CGNAT), gateway `100.64.0.1`; public endpoint `sb-2avrtqdb30pt.vercel.run`; `VSCODE_PROXY_URI=/proxy/{{port}}/`; kernel-forwarded ports `23456`, `30001–30010`; no iptables NAT rules |
| Trust anchors | `vercel-proxy-ca.pem` / `.crt` bind-mounted for HTTPS interception |
| Users | `vercel-sandbox` uid 1000 (owner of everything); root |
| Toolchain | node 24.14.1, npm 11.11, pnpm 10.34.3, yarn, uv, python 3.13, code-server 0.0.0 (Code 1.108.1), ttyd 1.7.7, gh, git, ssh-keygen/gpg/ssh-agent |

### 3.2 Runtime components under `/vercel/share`
| File | Role | Live state |
|---|---|---|
| `v0-supervise.sh` | per-service process supervisor (flock, pidfiles, group-kill escalation, crash backoff, legacy pm2 cleanup) | running for `v0-code-server`, `v0-log-proxy` |
| `v0-log-proxy.js` | localhost control plane: WS log streaming, file-backed detached exec, 500-event history | running (:7682) |
| `v0-code-server.sh` | editor launcher (config/user-data under `/vercel/share/.config`, `.local`), workspace `v0-project` | running (:4444) |
| `v0-ttyd.sh` | web terminal (`bash -l`, `-w v0-project`) | **down** (binary present; supervisor not resumed at boot) |
| `v0-metrics.sh` | 60s resource metrics → callback | **down** |
| `v0-runtime/register.mjs` + `config-loader.mjs` | Node module hooks injecting dev-server overrides (AI agent ingress) | loaded on demand via `NODE_OPTIONS` |
| `v0-git-ssh-sign` + `v0-git-ssh-allowed-signers` | `ssh-keygen -Y sign` proxy → hosted signing service | present |
| `v0-bridge` (code-server extension) | editor control API on `127.0.0.1:9876` (inside extension host) | running |
| `.env.project` | identity: OIDC token, `AI_GATEWAY_API_KEY`, `V0_CALLBACK_URL`, `V0_CODE_SERVER_CALLBACK_URL/TOKEN`, `V0_RUNTIME_URL`, analytics | present |
| `v0-project/` | the sample/working codebase | **excluded from migration** |
| `logs/`, `run/`, `.config/`, `.local/`, `.v0-sync-state/` | runtime state | present |
| `/vercel/bin/git-credential-helper` | credential fill helper | referenced by git config |

### 3.3 Host-owned infrastructure (not in `/vercel/share`)
`sandbox-init` (PID 1), `init.sock`, the Vercel proxy CA, the CGNAT gateway,
and the kernel-forwarded ports — none are userspace logic, all are
infrastructure-owned.

---

## 4. AI feature identification & classification

The v0 platform's "AI-ness" is not a monolith — it is a connection layer that
lets an external AI agent observe and steer the sandbox. Identified features:

| # | AI feature | Mechanism | Migrated as |
|---|---|---|---|
| F1 | **Agent browser ingress** | `config-loader.mjs`/`register.mjs` force `allowedDevOrigins` + `serverActions.allowedOrigins` so the agent's browser origin can reach `next dev` (HMR websockets, server actions) | `lib/config-loader.mjs`, `lib/register.mjs` (+ `NEXOS_ALLOWED_DEV_HOSTS`) |
| F2 | **Agent observation (logs)** | log-proxy tails service + exec output over WS; 500-event history; `adminOnly` filter | `lib/log-proxy.js` |
| F3 | **Agent control (exec)** | log-proxy `/execute` runs commands detached with file-backed stdio so they outlive proxy restarts | `lib/log-proxy.js` |
| F4 | **Agent editor mutation** | bridge API (`/set-readonly`, `/reload-files`, `/set-workspace-name`) toggles the open editor | `bridge/standalone.js` (fs handlers) + `bridge/editor-extension/` (live handlers) |
| F5 | **Session identity / callbacks** | `.env.project` token + `V0_CODE_SERVER_CALLBACK_URL/TOKEN`; metrics + sync push to the control plane | `config/nexos.env` template; `lib/metrics.sh` (preference-ordered `NEXOS_*`/`V0_*`) |
| F6 | **Trusted git signing** | signing keys never on host; `ssh-keygen -Y sign` proxied | `git/ssh-sign.sh`, `git/allowed-signers` |
| F7 | **Resource telemetry** | 60s `{type:"metrics_report",metrics:{…}}` payload | `lib/metrics.sh` |
| F8 | **Host auth** | `sandbox-init` pubkey + socket | **not migrated** (host-infrastructure) |
| F9 | **AI credentials** | `AI_GATEWAY_API_KEY`, OIDC token | **not migrated** (platform secrets, out of scope) |
| F10 | **The agent itself** | the v0.dev agent / agent-browser | **not migrated** (external service) |

### Reusability triage
- **Migrate (all of Section 4's F1–F7 + editor/terminal + supervisor):** yes.
- **Platform-owned (not reusable standalone):** `sandbox-init`/init.sock, proxy
  CA, CGNAT/ingress ports, pm2 legacy bootstrap, Vercel AI-gateway/OIDC creds.
- **Excluded (explicit instruction):** `v0-project/`.

---

## 5. Isolation decisions (how each binding was removed)

| Binding in source | Isolation |
|---|---|
| `/vercel/share/logs`, `/vercel/share/run` | `NEXOS_ROOT/state/{logs,run}` via `NEXOS_SUPERVISE_LOG_DIR/RUN_DIR` |
| ports `4444/7681/7682/9876` | `NEXOS_EDITOR/TERMINAL/LOG_PROXY/BRIDGE_PORT` |
| `?v0-passthrough` query | `?nexos-passthrough` |
| `*.vusercontent.net / *.v0.build / *.vercel.run` | `*.nexos.build / *.nexos.run / *.nexos.net` + `NEXOS_ALLOWED_DEV_HOSTS` (JSON) |
| `V0_*` env names | `NEXOS_*` with `V0_*` legacy fallback |
| `/vercel/share/.env.project` | `config/nexos.env` (generated from `nexos.env.example`; gitignored) |
| git-sign endpoint `git-sign.v0.app` | `NEXOS_GIT_SIGN_URL` + `NEXOS_GIT_SIGN_NAMESPACE_HEADER` |
| editor config/user-data under `/vercel/share/.config`, `.local` | under `state/config`, `state/user-data` |
| loopback-only control plane | `NEXOS_ALLOW_REMOTE` opt-in for Docker port publishing |
| workspace `v0-project` | `NEXOS_WORKSPACE` (default `$NEXOS_ROOT/workspace`) |

**Preserved contracts (the "load-bearing" behaviors):**
1. Supervisor liveness = `ps` command match (survives PID-namespace reuse), not
   bare `kill -0`; stop/restart kill the process group with TERM→escalation→KILL;
   flock on fd 9 closed with `9>&-` at spawn to avoid self-deadlock.
2. Exec children are `spawn(...,{detached:true})` with file-backed stdio (never
   pipes) so user processes outlive proxy restarts; single 100ms tail ticker;
   50ms WS batching; 500-event history; `adminOnly` filter.
3. Metrics payload shape `{type:"metrics_report",metrics:{memTotalMB,…}}`
   unchanged.
4. Node components read config from the environment only (never `require()` the
   shell `.conf`).

**Defects found & fixed during migration:**
- log-proxy `wait:true` hung on ENOENT (missing child had `pid === undefined`,
  not `null`) — now resolves `{success:false,pid:null,error}`.
- entrypoint `service_enabled` used a nested `eval` default that blew up under
  `set -u` — replaced with indirect expansion `${!varname:-}`.
- `metrics.sh` `get_var` returned *file-order* matches, not preference order —
  rewritten to test each candidate name in order.

---

## 6. Migration artifacts (NexOS component registry)

| # | NexOS component | Source | Status |
|---|---|---|---|
| 1 | `lib/supervisor.sh` | `v0-supervise.sh` | migrated + tested |
| 2 | `lib/log-proxy.js` | `v0-log-proxy.js` | migrated + bugfixed + tested |
| 3 | `lib/metrics.sh` | `v0-metrics.sh` | migrated + preference-order + tested |
| 4 | `lib/register.mjs`, `lib/config-loader.mjs` | `v0-runtime/*` | migrated + hosts renamed |
| 5 | `services/editor.sh` | `v0-code-server.sh` | migrated (code-server 4.117.0) |
| 6 | `services/terminal.sh` | `v0-ttyd.sh` | migrated + tested in container |
| 7 | `bridge/bridge-api.js` | v0-bridge extension `api-server.js` | rewritten clean + tested |
| 8 | `bridge/standalone.js` | — (new) | supervised bridge service + tested |
| 9 | `bridge/editor-extension/` | — (new) | live-editor handlers + tested |
| 10 | `git/ssh-sign.sh`, `git/allowed-signers`, `git/credential-helper` | v0 git helpers | migrated |
| 11 | `bin/nexos` (CLI) | — (new) | init/start/stop/status/run/exec |
| 12 | `bin/entrypoint.sh` | — (new) | container entrypoint + graceful shutdown |
| 13 | `Dockerfile`, `.dockerignore`, `docker-compose.yml` | — (new) | image build + deployment |
| 14 | `ARCHITECTURE.md`, `COMPONENT-MAP.md`, `README.md`, `AGENTS.md` | — (new) | docs |

**Test suite (`npm test`, all green):** `supervisor-smoke.sh`,
`log-proxy-smoke.mjs`, `metrics-smoke.sh`, `bridge-smoke.sh`,
`editor-extension-smoke.mjs`.

**Container validation:** image `nexos:latest` runs all five supervised
services; control-plane health/exec/history round-trip verified; bridge state
persists; metrics fires with a configured callback; SIGTERM shuts everything
down cleanly with no leaked processes on the host.

---

## 7. Gap analysis (summary — full detail in ARCHITECTURE.md)

1. **PID-1 control channel** (`sandbox-init` + auth socket) — not replicated;
   host-infrastructure.
2. **Proxied ingress** (`VSCODE_PROXY_URI`, kernel ports `23456`/`30001–30010`)
   — no in-NexOS reverse proxy; documented as platform-owned.
3. **Live editor coupling** — originally inside the extension host; now
   reproduced by the bundled `bridge/editor-extension/` (either/or with the
   standalone bridge).
4. **Loopback control plane** — strict by default; `NEXOS_ALLOW_REMOTE=true`
   opts in for Docker port publishing (compose documents it).
5. **Version deltas** — code-server 0.0.0 → 4.117.0 (the point of the image);
   node 24 (host) vs 22 (image).
6. **Identity parity** — `nexos.env.example` now mirrors the `.env.project`
   split (generic vs per-service callback names, `NEXOS_RUNTIME_URL`).

---

## 8. Future work

- Self-hosted **agent-browser ingress**: a NexOS-owned reverse proxy / tunnel
  replacing `VSCODE_PROXY_URI` for the `*.nexos.build` hostnames.
- **Auth for the control plane** — **done**: `NEXOS_LOG_PROXY_TOKEN` /
  `NEXOS_BRIDGE_TOKEN` enforce bearer-token auth for remote clients (loopback
  stays trusted, remote clients are forced non-admin without a token).
- **Extension packaging** — **done**: `bridge/editor-extension/build-vsix.sh`
  emits a self-contained `nexos-bridge-<ver>.vsix` (vendored transport, stripped
  fallback); verified by `tests/vsix-smoke.sh`.
- **Self-hosted signing service** — **done**: `git/sign-server.js` is a reference
  implementation of the v0 git-sign endpoint (ed25519, SHA-256/SHA-512, token
  gate, namespace-bound signatures) so `NEXOS_GIT_SIGN_URL` can point at an owned
  endpoint. Keys come from `nexos sign-keygen`. Its SSHSIG output is
  byte-for-byte identical to `ssh-keygen -Y sign` for the same key, and is
  verified independently by `tests/verify-sshsig.mjs` (a faithful
  reimplementation of `ssh-keygen -Y verify`); covered by
  `tests/sign-server-smoke.sh`.

---

## Appendix — source file inventory (pre-migration, authoritative)

```
/vercel/share/
├── .env.project            identity (OIDC, AI gateway, callbacks, runtime URL)
├── v0-supervise.sh         supervisor
├── v0-log-proxy.js         control plane (logs + exec)
├── v0-code-server.sh       editor launcher
├── v0-ttyd.sh              terminal launcher
├── v0-metrics.sh           metrics daemon
├── v0-runtime/             register.mjs + config-loader.mjs (AI ingress hooks)
├── v0-git-ssh-sign         ssh signing proxy
├── v0-git-ssh-allowed-signers
├── v0-project/             EXCLUDED (instruction)
├── logs/ run/ .config/ .local/ .v0-sync-state/    runtime state
/run/vercel/share/          sandbox-init (PID 1) + init.sock   (platform-owned)
/opt/vercel/share/          sandbox-init copy                  (platform-owned)
/vercel/bin/git-credential-helper   credential fill helper
```
