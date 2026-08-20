# Agent-browser ingress — design + implementation plan

**Status:** scoping doc (Phase 1 = server + config + CLI wiring).
**Closes:** `MIGRATION-REPORT.md` §8 "Self-hosted agent-browser ingress" +
`ARCHITECTURE.md` §4 gap A2 ("Proxied ingress", `VSCODE_PROXY_URI` + kernel-forwarded ports).
**Date:** 2026-08-20.

## 1. What the platform had

The Vercel sandbox reached its services through a platform-owned ingress that
NexOS did not migrate:

| Mechanism | Platform behavior | NexOS today |
|---|---|---|
| `VSCODE_PROXY_URI=/proxy/{{port}}/` | path prefix `/proxy/<port>/<path>` forwards to `127.0.0.1:<port>/<path>` | none — direct ports only |
| `*.nexos.build` / `*.vusercontent.net` dev hosts | wildcard hostnames resolving to the sandbox public endpoint; the AI agent browser reaches `next dev` (HMR websockets + server actions) through them | `lib/config-loader.mjs` already *accepts* `*.nexos.build` as an allowed dev origin, but nothing serves those hostnames |

The framework-hooks side (`NEXOS_ALLOWED_DEV_HOSTS`, defaulting to
`*.nexos.build` / `*.nexos.run` / `*.nexos.net`) is the intended hostname scheme;
the missing half is the reverse proxy that makes those hostnames resolve to the
workspace's dev server.

## 2. Design

A single dependency-free `node:http` reverse proxy, `lib/ingress.js`, supervised
as the `ingress` service. One port, two routing schemes, v0 parity plus NexOS
convenience.

### 2.1 Configuration (`config/nexos.conf`)

| Var | Default | Notes |
|---|---|---|
| `NEXOS_INGRESS_PORT` | `8083` | free (4444/7681/7682/8080/8081/8082/9876/9877 taken) |
| `NEXOS_INGRESS_HOST` | `127.0.0.1` | `0.0.0.0` when `NEXOS_ALLOW_REMOTE=true` |
| `NEXOS_INGRESS_TOKEN` | (empty) | optional bearer for remote clients; loopback always trusted; unset = no auth |
| `NEXOS_INGRESS_ROUTES` | `{"*.nexos.build":"http://127.0.0.1:3000","*.nexos.run":"http://127.0.0.1:4444","*.nexos.net":"http://127.0.0.1:7681"}` | JSON host→upstream map; `*.` prefix = any subdomain |

Defaults match `NEXOS_ALLOWED_DEV_HOSTS` (`lib/config-loader.mjs`), so a hostname
the framework accepts is one the ingress serves.

### 2.2 Routing

1. **Path scheme (v0 parity):** `/proxy/<port>/<path>` → `http://127.0.0.1:<port>/<path>`
   (prefix stripped, query preserved). Numeric port 1–65535 only; anything else → 404.
   Loopback-only targets make this **SSRF-safe** by construction.
2. **Host scheme:** `Host: <sub>.<domain>` where `<domain>` matches a route key
   (`*.nexos.build` → `127.0.0.1:3000`). Numeric subdomain convenience:
   `<port>.nexos.build` → `127.0.0.1:<port>` for any port (covers editor/terminal/
   web/api/preview without config). Unknown host → 404.

### 2.3 Forwarding semantics

- Header hygiene reused from `api/lib/preview.mjs`: drop hop-by-hop +
  `x-forwarded-*`/`x-envoy-*`/`x-vercel-*`/`x-now-*`; rewrite `Host` to the
  upstream; set `X-Forwarded-For` to the client address.
- Bodies piped, responses streamed (no buffering → SSE safe). Response headers
  pass through minus hop-by-hop; cache-control untouched (unlike the preview
  ingress, which pins `private, no-store`).
- **WebSocket `upgrade` passthrough** (required for `next dev` HMR + server
  actions): forward `Connection: Upgrade` + `Sec-WebSocket-*`, pipe both sockets,
  tear down both on error/close. Token auth for remote WS clients uses the
  `?token=` query (WS clients cannot set headers), stripped before forwarding.
- Auth: loopback trusted; non-loopback requires `Authorization: Bearer
  $NEXOS_INGRESS_TOKEN` (or `?token=`) when a token is set. Matches the
  web/git-sign model.

### 2.4 Wiring surface (standard 7-file service touch)

1. `lib/ingress.js` — server (this phase)
2. `config/nexos.conf` — `NEXOS_INGRESS_*` defaults (this phase)
3. `bin/nexos` — `service_cmd` entry (this phase)
4. `bin/entrypoint.sh` — start/stop list + banner (this phase)
5. `Dockerfile` EXPOSE + `docker-compose.yml` port
6. `tests/ingress-smoke.sh` — suite, registered in `npm test`
7. Docs: README (layout + control-plane/Docker tables), COMPONENT-MAP,
   ARCHITECTURE §5 follow-up, MIGRATION-REPORT §8 strike-through, AGENTS.md

## 3. Verification

`tests/ingress-smoke.sh` boots real backends on high ports (AGENTS.md sandbox
convention): a plain HTTP echo server (path routing, header hygiene, host
rewrite) and a `ws` echo server (upgrade round-trip). Checks: `/proxy/<port>/`
path routing, host routing via `curl -H 'Host: …'`, numeric-subdomain routing,
SSRF guards (non-numeric / out-of-range port → 404), response streaming, WS echo,
remote token gate (401 without / 200 with). Plus the AGENTS.md Docker flow
(build `--network=host`, high ports, `docker logs` banner, curl each service,
clean shutdown with no leaked listeners).

## 4. Risks / decisions

- WebSocket upgrade is the only non-trivial bit; mitigated with a real-`ws`
  round-trip test and explicit error teardown.
- Default upstream for `*.nexos.build` assumes `next dev` on 3000; override via
  `NEXOS_INGRESS_ROUTES` (documented in README).
- Token gating applies to the path scheme / remote admin; browser HMR over the
  host scheme is typically unauthenticated (the dev server itself owns
  auth/authn decisions on the workspace origin).