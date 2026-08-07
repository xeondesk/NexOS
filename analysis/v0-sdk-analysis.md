# v0 SDK analysis + refactoring plan (v0.app production API)

Date: 2026-08-07. Source analyzed: `https://github.com/vercel/v0-sdk`
(clone at `/tmp/opencode/v0-sdk`, commit `27a1d36` "Release v3.0.3", 2026-08-04).

Scope note: `/vercel/share/v0-project/` is excluded by instruction; this doc is
about the **application-facing API contract** (v0.app / api.v0.dev), which the
sandbox analysis in `v0-app-architecture.md` does not cover.

## 1. What the SDK is

`v0-sdk` is the official TypeScript client for the v0 production **API v2**
(`https://api.v0.dev/v2`). It is not sandbox infrastructure — it is the external
surface that applications use to create chats, stream assistant progress, manage
previews, MCP servers, and webhooks. The SDK is generated from a checked-in
OpenAPI 3.1 document (`packages/v0-sdk/openapi.json`, 17.8k lines, title
"v0 API 2.0.0") via `@hey-api/openapi-ts`, plus hand-written helpers.

Packages:

| Package | Role |
|---|---|
| `v0` (`packages/v0-sdk`) | Generated REST client + hand-written streaming/auth/preview helpers. `./browser` entrypoint drops server auth. |
| `@v0-sdk/react` (`packages/react`) | AI SDK `V0Transport` (useChat), generated SWR hooks, stream→UIMessage reducer. |
| `@v0-sdk/ai-tools` (`packages/ai-tools`) | Every OpenAPI operation exposed as an AI SDK tool. |
| `create-v0-sdk-app` | Scaffolding CLI + `SKILL.md` template (SDK usage guidance). |

## 2. Production API v2 contract

### 2.1 Server + auth
- Base URL `https://api.v0.dev/v2`; auth is `bearer` (`V0_API_KEY`, from
  `v0.app/settings`) or **Vercel project-scoped OIDC** (`@vercel/oidc`) — a token
  minted for a Vercel project can only touch that project's resources.

### 2.2 Endpoints (41 operations)

**Chats** — `create`, `list`, `get`, `update` (PATCH), `delete`,
`createFromFiles`, `createFromZip`, `createFromRepo` (public GitHub or
Vercel-connected private repos, `{url, branch}`), `createStream`, `createAsync`,
`getPreview`, `getFiles`, `updateFiles`, `downloadFiles`, `getConnectStatus`,
`restoreMessage`, `duplicate`, `deploy` (returns `deploymentId`, build runs
async on Vercel), `createVercelProject` (`{name}`), `resume`.

**Messages** — `list` (cursor-paginated `{messages, cursor}`), `send`, `get`,
`sendStream`, `sendAsync`, `resolve` (task resolution: integration install,
plan review, question, permission request, Vercel Connect setup),
`resolveStream`, `resolveAsync`, `stop` (`POST .../messages/{id}/stop`).

**MCP servers** — CRUD (`{name,url,description,enabled,auth,scope}`).

**Settings** — `preview-hosts` GET/PUT (`TrustedPreviewHosts {hosts[]}`).

**Webhooks** — CRUD (`{name,events,url,chatId}`).

**Async pattern** — `createAsync`/`sendAsync` return `{chatId,messageId}` /
`{messageId}`; poll the corresponding GET until complete.

### 2.3 Core models
- **Chat**: `id`, `title`, `privacy` (`public|private|team|team-edit|unlisted`),
  `createdAt/updatedAt`, `authorId`, `vercelProjectId`, `metadata{}`,
  `writePermission`. `additionalProperties:false`.
- **Message**: `id`, `chatId`, `role`, timestamps, `content` (trailing prose),
  `parts[]`, `finishReason`, `restorable`, `attachments[]`, `authorId`, `usage`.
- **Message parts** (the action trace): `text`, `thinking`, `file-read{paths}`,
  `file-edit{operation,path,toPath}`, `search{scope,query}`, `bash{command,
  output,exitCode,isDangerous,timeoutMs}`, `tool-call{name,input,output,status,
  suggestedPermissions}`, `agent-action{name,summary,data}` — each with
  `startedAt`/`finishedAt`.
- **Preview**: `{url, token, expiresAt}` or `null` (still starting).

### 2.4 Streaming wire format (the important reusable part)
`/chats/stream`, `/chats/{id}/resume`, `.../messages/stream`, `.../resolve/stream`
return **SSE** (`text/event-stream`). Event framing (from `stream/result.ts`):

```
event: update
data: {status, event, chat?, message?, title?, parts, usage?}

event: done
data: {status:'done', ...last update}

event: error
data: {message, code?, id?}
```

Stream event objects (discriminator `object`, from `ChatStreamEvent` /
`MessageStreamEvent`):
- `chat` — full chat snapshot (first + final)
- `chat.title` — `{id, object, delta}` title delta
- `message` — full message snapshot
- `message.parts.chunk` — `{id, object, delta}` **jsondiffpatch delta**
- `message.usage` — `{id, object, usage}`
- `error` — `{id, object, message, code}`

**Delta format** (`stream/diffpatch.ts`): standard `jsondiffpatch` deltas, PLUS a
v0 string-append fast-path: `[[idx, idx, ..., "appended text"], 9, 9]`. The
trailing `[9, 9]` marks "append-only string delta"; the integer path walks into
`parts[i].text` (etc.) and the final string is the appended tail. The SDK's
`patch()` handles both. This is how token streaming is made cheap over the wire.

`V0StreamResult` (`stream/result.ts`) is a fan-out wrapper: one async iteration
behind `stream`, `final`, and `toResponse()` (SSE re-serialization with
`Cache-Control: no-cache, no-transform`, `Connection: keep-alive`,
`X-Accel-Buffering: no`). `readV0Stream(response)` parses the SSE back into a
`V0StreamResult` (used by `@v0-sdk/react`).

### 2.5 Preview proxy semantics (`preview-proxy.ts`)
`fetchPreview` is the security-critical piece for embedding generated previews:
forward the incoming request to `preview.url` with short-lived
`x-v0-preview-token`, strip hop-by-hop + `x-vercel-*`/`x-forwarded-*`/`x-envoy-*`
headers, drop `set-cookie`/cache headers from the response, refuse cross-origin
path resolution (defense-in-depth against token exfiltration), redirect to a
loading `fallbackUrl` while preview is null or when
`x-v0-preview-refresh: 1` arrives (calling `onPreviewRefresh` to drop cache).
Previews are untrusted code → must live on a different registrable origin,
sandboxed iframe.

## 3. Reuse assessment for NexOS

NexOS today = the **sandbox control plane** (supervisor, log-proxy, editor,
terminal, bridge, metrics, git-sign) + a web portal dashboard. It has **no
application-facing API** — nothing that speaks the v2 contract the SDK is built
against. The SDK therefore opens a new capability: a self-hosted, v0-compatible
API layer.

### Directly reusable (port into NexOS, Apache-2.0)
| Source | NexOS target | Why |
|---|---|---|
| `packages/v0-sdk/openapi.json` | `api/openapi-v2.json` (reference) | The full v2 contract, versioned + machine-checkable. |
| `stream/diffpatch.ts` | `api/lib/diffpatch.mjs` | v0 delta wire format (`jsondiffpatch` + `[n,9,9]` append delta). Port is ~170 lines, deps `jsondiffpatch` only. |
| `stream/result.ts` | `api/lib/v0-stream.mjs` | SSE framing, `SharedV0StreamResult` fan-out, `readV0Stream`, error mapping. |
| `preview-proxy.ts` | `api/preview-proxy.mjs` | SSRF-safe preview forwarding + header hygiene + refresh handling. The hard security work is already specified. |
| `src/generated/types.gen.ts` (+ `openapi-ts`) | regenerated types | Keep `openapi.json` in sync and regenerate, same as upstream. |
| `vercel-oidc.ts` | pattern only | Project-scoped identity → equivalent `NEXOS_*` bearer auth (OIDC is Vercel-only). |
| `chat/chunks.ts` | `web/` dashboard stream renderer | Snapshot-reducer → incremental text chunks (append-only semantics) is directly reusable in a self-hosted chat UI. |

### Not reusable / Vercel-locked
- `@hey-api` generated client (`client.gen.ts`, SWR hooks, `@v0-sdk/react`
  transport) — client infrastructure for the hosted API; only useful once NexOS
  *is* a v2-compatible endpoint.
- `deploy`, `createVercelProject`, `connect/status`, Vercel-Connect resolver
  tasks — tied to Vercel's platform (NexOS would map these to local deploy hooks
  or drop them).
- `@vercel/oidc` — Vercel-only.

## 4. Refactoring plan — self-hosted v0-compatible API gateway

Phased development plan. Each phase is independently shippable + testable.

### Phase 0 — contract + scaffolding ✅ (commit `1857c79`)
- [x] Copy `openapi.json` → `api/openapi-v2.json` (Apache-2.0 attribution).
- [x] `api/` service skeleton supervised like others: `api-server.mjs`
  (node:http, no framework), routes matching the v2 paths, bearer auth via
  `NEXOS_API_TOKEN` + loopback-trust (reuse the web-portal auth model).
- [ ] Generated types: run `openapi-ts` in a scratch dir, vendor
  `types.gen.ts` into `api/types.mjs`-importable form (or keep TS + build).

### Phase 1 — streaming wire format ✅ (commit `3d440ed`)
- [x] Port `diffpatch.mjs` (jsondiffpatch + `[9,9]` append delta) + unit tests.
- [x] Port `v0-stream.mjs`: `formatSse`, SSE parse, `SharedV0StreamResult`,
  `applyStreamEvent`, `createV0StreamResult`/`readV0Stream`.
- [x] Wire `/chats/stream` + `/chats/{id}/messages/stream` + `/chats/{id}/resume`
  to emit real events (`chat`, `chat.title`, `message`, `message.parts.chunk`,
  `message.usage`, `error`) against local in-memory chat/message state.
- [x] Verify with the real SDK: `createV0Client({baseUrl:http://127.0.0.1:PORT/v2})`
  round-trip (`tests/api-stream-sdk.mjs`) + offline fixture tests
  (`tests/api-stream-unit.mjs`).
- [x] `messages.resolveStream` (Phase 2 store) — implemented in Phase 3
      continuation; see the check below.

### Phase 2 — chat/message CRUD + persistence ✅ (commit `d60cdfb`)
- [x] Chats: create/list/get/update/delete/duplicate; Messages:
      list/send/get/stop; restore-message. Persist to `state/api/` (JSON + atomic
      writes, reuse web-portal settings write pattern).
- [x] Async variants (`createAsync`, `sendAsync`) → poll-able jobs dir.
- [x] `from-files` / `from-zip` / `from-repo` (local: zip extract into workspace;
      repo: `git clone` — NexOS already owns git infra).

### Phase 3 — preview + MCP + webhooks ✅ (commit `c988b6e`)
- [x] `getPreview` → `{url, token, expiresAt}` (HMAC-signed, chat-scoped, 30 min
      TTL) over the preview ingress; `null` while the chat has no files; 404 for
      unknown chats (`api/lib/preview.mjs` + `meta-handlers.mjs`).
- [x] Port `preview-proxy.mjs` as a preview ingress (origin-isolated, hop-by-hop +
      `x-vercel-*`/`x-forwarded-*`/`x-envoy-*` header stripping, `private,
      no-store` pinning, `x-v0-preview-refresh: 1` → `/_loading` fallback). The
      default upstream is an internal mock static server over the chat's ingested
      files; `NEXOS_PREVIEW_UPSTREAM` points it at a real dev server instead.
- [x] `mcp-servers` CRUD (persisted, with auth) — maps to real MCP connections.
- [x] `hooks` webhook CRUD + delivery loop (event → POST url, retries, delivery
      log at `state/api/webhook-deliveries.jsonl`).
- [x] `settings.preview-hosts` GET/PUT (`TrustedPreviewHosts {hosts[]}`).
- [x] Verified: `tests/api-meta-smoke.sh` (27 checks) + `tests/api-preview-smoke.sh`
      (15 checks) + ingress unit coverage in `tests/api-preview-smoke.sh`; full
      `npm test` green.
- [x] `chats.downloadFiles` (`GET /chats/{chatId}/files/download`) streams a
      dependency-free stored ZIP of the chat's ingested files
      (`api/lib/zip.mjs`, UTF-8 flag + POSIX modes, base64/utf8 content), and
      `chats.getConnectStatus` polls persisted connector state
      (`state/api/connectors.json`, seeded by requestId) returning the spec'd
      `pending`/`ready`/`error` oneOf — default `error:
      vercel_connect_not_configured` when unset. Covered in `api-crud-smoke.sh`.
- [x] `messages.resolve*` family (Phase 3 continuation): `resolve`, `resolveAsync`,
      `resolveStream` implemented in `api/lib/mock-generator.mjs` (`validateTask`,
      `mockResolve`, `RESOLVE_TASK_TYPES`) with handlers in `chat-handlers.mjs` /
      `stream-handlers.mjs`. Task types: `confirmed-steps`, `plan-exit-response`
      (status `approved|rejected|request-changes`), `answered-questions`,
      `confirmed-permissions`, `vercel-connect-setup`. Sync → follow-up Message
      (200); async → `AsyncMessage {messageId}` (202); stream →
      `MessageStreamEvent` frames (opening snapshot → `message.parts.chunk` deltas
      → `message.usage` → closing snapshot) + `message.finished` webhook. Covered
      in `api-crud-smoke.sh` (+7) and `api-stream-smoke.sh` / `api-stream-sdk.mjs`
      (+6 real-SDK checks, incl. the hey-api `{data,...}` envelope + flat
      `{chatId, task}` params for the non-stream variant).
- [ ] `deploy`, `createVercelProject` still 501 (Vercel-locked, deferred).

### Phase 4 — React/SDK client compatibility
- [ ] Run `@v0-sdk/react` `V0Transport` against local proxy routes; ship the
      dashboard chat UI using the stream renderer from `chat/chunks.ts`.
- [ ] `ai-tools` parity only if a self-hosted model backend exists (out of scope
      until then).

### Phase 5 — docker + docs ✅
- [x] `api` added to `bin/entrypoint.sh`, Dockerfile EXPOSE, compose ports
      (8081) + preview ingress (8082) in EXPOSE/compose/banner; compose
      documents `NEXOS_ALLOW_REMOTE` flipping the gateway + preview bind.
- [x] `npm test` suite (16 suites incl. real-SDK round trip, CRUD, meta,
      preview); README/COMPONENT-MAP/AGENTS updated.
- [x] Commit each phase separately, same style as prior work.

### Deferred / explicitly out of scope
- Vercel-only ops (`deploy`, `createVercelProject`, Vercel Connect) — replace
  with local equivalents or gate behind `NEXOS_ENABLE_API_VERCEL_*`.
- `@vercel/oidc` auth — replaced by `NEXOS_API_TOKEN` bearer.
- Model generation itself (v0-pro etc.) — needs an LLM backend; the API gateway
  contract can be implemented with a mock/echo stream for test parity.
