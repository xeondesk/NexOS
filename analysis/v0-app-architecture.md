# v0.app Current-State Architecture — Baseline for the git-sign Wire-Contract Fix

**Purpose:** baseline analysis of the current v0.app system (host platform runtime,
application architecture, and the hosted git-sign endpoint) that drives a future
fix in NexOS's self-hosted signing service so its wire contract matches the
hosted endpoint byte-for-byte.

**Date:** 2026-08-06 · **Host:** Amazon Linux 2023 (node 24.14.1) ·
**Scope:** `/vercel/share/` runtime + `/vercel/share/v0-project/` (read-only
analysis; the project itself remains excluded from NexOS migration).

---

## 1. Platform & runtime inventory (live, re-checked 2026-08-06)

| Item | Detail |
|---|---|
| OS / toolchain | Amazon Linux 2023, kernel 6.18.40, node 24.14.1, pnpm, OpenSSH 8.7p1 |
| PID 1 | `sandbox-init` (Vercel host infra; not userspace logic) |
| Supervised services | `v0-log-proxy` (:7682), `v0-code-server` (:4444), `v0-ttyd` (:7681), `v0-metrics-daemon` — all four running via `v0-supervise.sh run <name>` |
| Bridge | code-server extension control API on `127.0.0.1:9876` |
| Runtime identity | `.env.project` — `AI_GATEWAY_API_KEY`, `VERCEL_WEB_ANALYTICS_ID`, `VERCEL_OIDC_TOKEN`, `NEXT_PUBLIC_DEV_SUPABASE_REDIRECT_URL`, `V0_RUNTIME_URL`, `V0_CALLBACK_URL`, `V0_CODE_SERVER_CALLBACK_URL`/`TOKEN` (names sanitized) |
| v0 project ids | `prj_dRbioEbmZ3aP3KBF11zzrQhmJamq` / `team_CQRIMuTPJ0RjtoyacvAZOv3v` |

Process tree: supervisors (`/vercel/share/v0-supervise.sh run <name> -- bash -c …`)
wrap each child; the supervisor stops/restarts the whole process group so user
processes spawned by the log proxy (detached) survive restarts.

## 2. v0.app application architecture (`v0-project` = `khulnasoft-platform`)

pnpm 9 monorepo: `apps/portal` (single-file dark dashboard), 17 `services/*`
entries, `packages/{core,sdk}`, `tooling/`, `infra/kubernetes`,
`docs/architecture/platform-architecture.md`, `PLAN.md`, `AGENT.md`.

### API surface — `services/api-server.js` (1253 lines)
- Pure `node:http`, no framework; JSON error envelope
  `{ error: { code, message, requestId } }` + `X-Request-Id` echo on every response.
- Routes: `GET /health`, `GET /ready`, `GET /metrics` (Prometheus text),
  `GET /api/v1/slos`, plus ~60 CRUD/action routes over 14 domain services
  (incidents, deployments, notifications, pipelines, security, vault, packages,
  sboms, compliance, identity/RBAC, runs, github, releases, artifacts,
  repositories, reviews, sandboxes).
- Persistence: `JsonFileStore` atomic snapshot to `data/platform-state.json`
  (temp+rename), debounced save after every successful POST (40ms), flush on
  SIGINT/SIGTERM; each service implements `exportState()`/`importState()`.
- Observability: per-request metric captured on `res` `finish`; in-process
  counters, two SLO budgets (availability >= 99%, p95 <= 500ms over 5-min
  windows), incident lifecycle, structured JSON request logs.
- Sandbox/code-runner semantics are simulations: submitted code is never executed.

### Loader — `services/domain-bridge.js` (61 lines)
- Single-flight lazy `Promise.all` import of 16 TypeScript services (Node
  type-stripping), exposed as `{ RepositoryIndexer, analyzePullRequest,
  reviewPullRequest, SandboxService, ObservabilityService, ReleaseOrchestrator,
  JsonFileStore, GitHubPlatform, CodeRunner, DeployService, NotificationsService,
  PipelineService, SecurityService, VaultService, RegistryService, SbomService,
  IdentityService }`.
- `loader.critical` gate via `DISABLE_DOMAIN_SERVICES`; load errors are cached
  and rethrown; `/ready` reports 503 when domain or observability is down.

### Domain services (all dependency-free, in-memory, state via export/import)
repo-indexer, ai-review, sandbox-orchestrator, observability, release-orchestrator,
persistence, github-platform, code-runner, deploy-service, notifications,
ci-pipeline, security, vault, package-registry, sbom-compliance, identity.

## 3. Control plane — `v0-log-proxy.js` (600 lines)

- WebSocket streaming with 50ms batch flushing (`logs-batch`), 500-event in-memory
  history, `adminOnly` events filtered for non-admin clients.
- HTTP routes: `GET /health`, `GET /history?since=&isAdmin=`, `POST /execute`,
  `POST /clear`, `POST /log`. Non-loopback requests → 403.
- Exec: children are `spawn(..., {detached:true})` with file-backed stdio (never
  pipes) so user processes outlive proxy restarts; output tailed through one
  shared 100ms ticker (64KB max read/tick, 10MB ftruncate cap); orphaned
  `exec-<pid>-<seq>.out/.err` files from prior proxy runs cleaned on boot;
  PTY mode via `/usr/bin/script -qefc`.

## 4. Framework runtime hooks — `v0-runtime/`

- `register.mjs`: skipped inside pnpm (pnpmfile probe swallows only native
  errors; crossing the customization-hooks worker loses the native-error brand);
  sets `__NEXT_NODE_NATIVE_TS_LOADER_ENABLED` and registers `config-loader.mjs`.
- `config-loader.mjs`: intercepts `next.config.{js,ts,mjs,mts}` via
  `?v0-passthrough`, merges v0 overrides: `allowedDevOrigins`
  (`*.vusercontent.net`, `*.dev-vm.vusercontent.net`, `*.v0.build`,
  `*.vercel.run` + `V0_ALLOWED_DEV_HOSTS` JSON) and
  `experimental.serverActions.allowedOrigins` so the agent browser can reach
  `next dev` (HMR websocket handshake + server actions).

## 5. Hosted git-sign wire contract (empirically probed 2026-08-06)

Endpoint `https://git-sign.v0.app/sign` — a Vercel `sandbox-proxy/[[...path]]`
route (headers `X-Matched-Path`, `X-Vercel-Id`). The host has no `/health`; any
request lacking a payload returns `400 {"error":"Signing payload is empty"}`.

**Request contract:**

| Aspect | Observed behavior |
|---|---|
| Method/path | `POST /sign` |
| Content-Type | required, exactly `application/vnd.git.ssh-signature-request` (missing or `application/octet-stream` → `415 {"error":"Unsupported content type"}`) |
| Accept | `application/vnd.git.ssh-signature` (client contract; not strictly enforced) |
| Namespace header | `x-v0-git-signing-namespace`; optional — **defaults to `git`** when absent; present-but-not-`git` → `400 {"error":"Invalid signing namespace"}` (tested `git:commit`, `v0`, principal-form → all rejected) |
| Body | raw payload bytes; empty → `400 {"error":"Signing payload is empty"}` |

**Response contract:** `200`, `Content-Type: application/vnd.git.ssh-signature`,
header `X-V0-Git-Signing-Key-Id: it+v0agent@vercel.com`, body = armored
`-----BEGIN SSH SIGNATURE-----`. SHA-512, ed25519. The captured signature
verifies with the reference verifier against the published allowed-signers key
(`it+v0agent@vercel.com`, ssh-ed25519, SHA256:318f451f3d7a02b5f58fddb1c95450c5f5adde524301778c56de743531a34ab6).

## 6. Contract deltas vs NexOS `git/sign-server.js` — fix candidates

| # | Aspect | Hosted v0 endpoint | NexOS sign-server | Fix action |
|---|---|---|---|---|
| A | Namespace validation | whitelist — only `git` accepted (400 otherwise) | any non-empty namespace accepted | add `NEXOS_GIT_SIGN_ALLOWED_NAMESPACES` (default `git`, `*` to disable); 400 on mismatch |
| B | Content-Type enforcement | required `application/vnd.git.ssh-signature-request` (415 otherwise) | not checked | optionally require the request content type (415) |
| C | Empty payload | 400 "Signing payload is empty" | signs empty bodies | reject empty payload (400) |
| D | Default namespace | `git` when header absent | 400 missing-header | optionally default to `git` |
| E | Response headers | `Content-Type: application/vnd.git.ssh-signature`, `X-V0-Git-Signing-Key-Id: <principal>` | `application/vnd.git.ssh-signature` + `X-Nexos-Git-Sign-Key: <pubkey-line>` | align the key-id header name/principal (optional) |
| F | Superset routes | none (`/health` → 400 empty-payload) | `/health`, `/pubkey`, token gate, arbitrary-path 404 | keep — useful superset, not a defect |

NexOS already matches: raw payload, namespace header name, SHA-512, ed25519,
RFC 4251 plain-string namespace/hashalg, armored output. Its signature output is
byte-for-byte identical to `ssh-keygen -Y sign` for the same key/data/namespace.

## 7. Reconciliation with MIGRATION-REPORT.md

- Feature F6 (trusted git signing) mapped to `git/ssh-sign.sh` + `git/allowed-signers`;
  §8 marked "Self-hosted signing service — done" (`git/sign-server.js`).
- This analysis is the follow-up: it pins the hosted endpoint's exact wire
  contract (§5) and the remaining behavioral delta (§6) as the fix target.
  `git/ssh-sign.sh` already sends the correct content-type/accept/namespace
  headers, so the client side needs no change for fixes A–D.

## 8. Next steps

1. Implement A–D in `git/sign-server.js` behind `NEXOS_*` env defaults that
   preserve current behavior unless tightened.
2. Extend `tests/sign-server-smoke.sh` with the new guards (namespace whitelist,
   content-type 415, empty-payload 400, default-namespace).
3. Re-run `npm test`, rebuild/validate the Docker image, commit + push.
