# NexOS — current-OS architecture comparison & gap analysis

Date of analysis: 2026-08-06, against the live Vercel v0 sandbox (`a2634284-724`).

## 1. Current platform architecture (live sandbox)

| Layer | Reality |
|---|---|
| OS | Amazon Linux 2023, kernel 6.18.40 x86_64, 4 vCPU / 8 GB, cgroup v2, docker overlay2 (dockerd 25.0.14) |
| PID 1 | `sandbox-init` (Vercel) at `/run/vercel/share/sandbox-init` — unix socket + pubkey auth. No systemd runtime (binary present, zero units) |
| Network | `eth0 100.64.78.190/16` (CGNAT), gateway `100.64.0.1`; public endpoint `sb-…vercel.run` via `VSCODE_PROXY_URI=/proxy/{{port}}/`; infra-forwarding ports `23456` + `30001–30010` (kernel-level, no userspace process, no iptables NAT) |
| Identity | `/vercel/share/.env.project`: OIDC token, `V0_CALLBACK_URL`, `V0_CODE_SERVER_CALLBACK_URL/TOKEN`, `V0_CALLBACK_DEPLOYMENT_TARGET`, `V0_RUNTIME_URL`, AI-gateway key, analytics |
| Git | Global `gh auth git-credential` for github/gist; `v0-git-ssh-sign` + `allowed-signers` for SSH commits |
| Toolchain | node 24.14.1, npm 11.11, pnpm 10.34.3, code-server **0.0.0 (Code 1.108.1)** vendored at `/usr/local/lib`, ttyd 1.7.7 |
| Users | `vercel-sandbox` uid 1000 (owns everything); root available |

**Live services (at analysis time):** only 2 of 5 supervised via `v0-supervise.sh`:
`v0-code-server` (:4444) and `v0-log-proxy` (:7682, `0.0.0.0` bind with loopback-only
403). The code-server **bridge API runs inside the extension host** on
`127.0.0.1:9876`. **`v0-ttyd` (:7681) and `v0-metrics-daemon` were down** — pidfiles
and logs survive from the pre-boot snapshot but the supervisor never resumed them.

## 2. NexOS architecture

Same component set, parameterized via `NEXOS_*` (defaults mirror v0 ports exactly:
4444/7681/7682/9876), plus: container packaging (node:22-bookworm, uid 2000,
HEALTHCHECK, multi-arch), `bin/nexos` CLI, `bin/entrypoint.sh` with graceful
shutdown, and the bridge as a **supervised standalone** service. Node components
read configuration from the environment only (never the shell `.conf`).

## 3. Parity map (live → NexOS)

| Capability | v0 (live) | NexOS | Parity |
|---|---|---|---|
| Supervisor | v0-supervise.sh | lib/supervisor.sh | Identical contract (ps-based liveness, group-kill escalation, pm2 legacy kept conditional) |
| Log/exec proxy | v0-log-proxy.js (`0.0.0.0` + loopback-403, detached file-backed exec) | lib/log-proxy.js | Exact, incl. bug-fixed `wait:true` on ENOENT |
| Metrics | v0-metrics.sh → `V0_CODE_SERVER_CALLBACK_URL` | lib/metrics.sh → `NEXOS_*` with `V0_*` fallback + legacy `.env.project` path | Full parity |
| Editor | code-server 0.0.0, workspace `v0-project`, config under `/vercel/share/.config` | code-server 4.117.0, `NEXOS_WORKSPACE`, state dir | Functional parity, version gap |
| Terminal | ttyd 1.7.7, `bash -l`, `-w v0-project` | services/terminal.sh, same flags, `NEXOS_WORKSPACE` | Identical |
| Bridge | inside extension host (mutates editor live) | bridge/standalone.js, filesystem handlers | Behavioral downgrade (see A4) |
| Runtime hooks | register.mjs / config-loader.mjs | lib/register.mjs / config-loader.mjs + `NEXOS_ALLOWED_DEV_HOSTS` | Parity, hosts renamed |
| Git identity | gh helper + ssh-sign | git/credential-helper + ssh-sign + allowed-signers | Parity, no gh wiring example |

## 4. Gap detection

**A. Functionality v0 has that NexOS lacks**
1. **PID-1 control channel** — `sandbox-init` socket + pubkey auth is the host's
   control/telemetry mechanism. NexOS has no equivalent; containers use a plain
   bash entrypoint + trap. (Platform-owned, out of migration scope.)
2. **Proxied ingress** — `VSCODE_PROXY_URI` public endpoint + kernel-forwarded
   ports. NexOS documents only direct port access; no reverse-proxy/ingress story.
3. **Per-service callback identity** — `.env.project` distinguishes `V0_CALLBACK_URL`
   vs `V0_CODE_SERVER_CALLBACK_URL`. NexOS `nexos.env.example` exposes a single
   `NEXOS_CALLBACK_URL` (metrics reads the legacy names too, so runtime parity holds).
4. **Live editor coupling** — v0's bridge runs in the extension host and can
   actually toggle read-only / reload files in the open editor. NexOS's standalone
   bridge only persists to state files. (Addressed by the optional editor extension,
   see `bridge/editor-extension/`.)

**B. Version/toolchain deltas** — code-server 0.0.0 (Code 1.108.1) → 4.117.0
(major security/feature delta; the point of the image build); node 24 host vs 22
image (irrelevant: NexOS needs ≥20, code-server needs 22); ttyd identical 1.7.7.

**C. Behavioral/security deltas (design, not missing)**
5. **Loopback-only control plane** — both proxies bind `0.0.0.0` and 403
   non-loopback clients. In Docker bridge mode, published ports `7682:7682` /
   `9876:9876` are unreachable (docker-proxy arrives as non-loopback); opt in with
   `NEXOS_ALLOW_REMOTE=true` (see `docker-compose.yml`).
6. NexOS starts **all** services in the container; the live platform currently runs
   2 of 5 — NexOS is more complete, not less.

**D. Out of scope (per migration brief)** — `v0-project`, sandbox-init, Vercel
proxy/CA trust anchors, OIDC/AI-gateway tokens, kernel infra ports, pm2 legacy
host bootstrap.

## 5. Addressed follow-ups

1. `NEXOS_ALLOW_REMOTE` — loopback control-plane reachability is now configurable
   (log-proxy 403 + bridge bind host); documented in compose/README and covered by
   smoke tests.
2. Self-hosted code-server extension (`bridge/editor-extension/`) — wires real
   editor handlers (read-only toggle, window/file reload, workspace name) into the
   bridge transport so the v0 bridge behavior can be reproduced outside the sandbox.
3. `config/nexos.env.example` — added per-service callback placeholders for parity
   with `.env.project`.
4. Git wiring — README section covering `gh auth git-credential`, `ssh-sign.sh`,
   and `allowed-signers` for self-hosted repos.
5. Control-plane auth — `NEXOS_LOG_PROXY_TOKEN` / `NEXOS_BRIDGE_TOKEN` require a
   bearer token from remote clients when `NEXOS_ALLOW_REMOTE=true` (loopback stays
   trusted); remote log-proxy clients without a token are forced non-admin.
   Covered by smoke tests; this closed the "auth for the control plane" future-work
   item in `MIGRATION-REPORT.md`.
6. VSIX packaging — `bridge/editor-extension/build-vsix.sh` publishes the bridge
   extension as an installable VSIX: vendored `bridge-api.js`, source-tree
   fallback stripped, verified self-contained by `tests/vsix-smoke.sh`. Closed the
   "extension packaging" future-work item.
