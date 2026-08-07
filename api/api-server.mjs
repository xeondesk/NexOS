// NexOS v0-compatible API gateway (Phase 3: previews + MCP + webhooks).
//
// Implements the v0.app production API v2 contract served at
// https://api.v0.dev/v2. The route table is derived at startup from
// `api/openapi-v2.json` (a copy of vercel/v0-sdk's openapi.json, Apache-2.0,
// https://github.com/vercel/v0-sdk) so the mounted surface can never drift
// from the spec. Phase 1 added the streaming ops (`chats.createStream`,
// `messages.sendStream`, `chats.resume`) on a deterministic mock backend.
// Phase 2 added chat/message CRUD + async variants + from-files/zip/repo,
// persisted atomically under NEXOS_API_STATE_DIR. Phase 3 adds chat previews
// (signed URL + origin-isolated ingress port of the SDK preview-proxy),
// mcp-servers CRUD, webhooks CRUD + delivery loop, and preview-hosts settings.
// The resolve family and local Vercel-project/deploy equivalents close out the
// whole spec — every operation in openapi-v2.json is implemented.
//
// Base URL: the API is served under `/v2` (matching api.v0.dev/v2). The SDK
// client connects with `createV0Client({ baseUrl: 'http://127.0.0.1:<port>/v2' })`.
//
// Auth (same model as web/api-server.js): loopback is always trusted.
// Non-loopback requests must present `Authorization: Bearer $NEXOS_API_TOKEN`
// (the SDK sends the API key as a bearer token). Unset token = auth disabled.
// Error responses use the v2 `Error` shape `{ message }`.
//
// Configuration (NEXOS_* env vars):
//   NEXOS_API_PORT       listening port (default 8081)
//   NEXOS_API_HOST       bind host (default 127.0.0.1; 0.0.0.0 when
//                        NEXOS_ALLOW_REMOTE=true)
//   NEXOS_API_TOKEN      optional bearer token for remote clients
//   NEXOS_API_STATE_DIR  persistence dir for chat/message/meta state
//   NEXOS_PREVIEW_PORT   preview ingress port (default 8082; separate origin
//                        from the API, per the origin-isolation requirement)
//   NEXOS_PREVIEW_UPSTREAM  base URL of the real preview origin (next/vite dev
//                        server). Unset = built-in mock upstream serving the
//                        chat's ingested files.
//   NEXOS_API_PREVIEW_SECRET  HMAC secret for preview tokens (default is fine
//                        for loopback; set it when publishing previews).

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as store from './lib/chat-store.mjs'
import * as streamHandlers from './lib/stream-handlers.mjs'
import * as chatHandlers from './lib/chat-handlers.mjs'
import * as metaHandlers from './lib/meta-handlers.mjs'
import * as webhooks from './lib/webhooks.mjs'
import { createPreviewServer } from './lib/preview.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const PORT = parseInt(process.env.NEXOS_API_PORT || '8081', 10)
const allowRemote = (process.env.NEXOS_ALLOW_REMOTE || '') === 'true'
const HOST = process.env.NEXOS_API_HOST || (allowRemote ? '0.0.0.0' : '127.0.0.1')
const TOKEN = process.env.NEXOS_API_TOKEN || ''
const STATE_DIR = process.env.NEXOS_API_STATE_DIR || path.join(ROOT, 'state', 'api')
const OPENAPI_FILE = path.join(__dirname, 'openapi-v2.json')
const PREVIEW_PORT = parseInt(process.env.NEXOS_PREVIEW_PORT || '8082', 10)
const PREVIEW_HOST = process.env.NEXOS_PREVIEW_HOST || (allowRemote ? '0.0.0.0' : '127.0.0.1')
const PREVIEW_SECRET = process.env.NEXOS_API_PREVIEW_SECRET || 'nexos-preview-token'
const PREVIEW_UPSTREAM = process.env.NEXOS_PREVIEW_UPSTREAM || `http://127.0.0.1:${PREVIEW_PORT}/_upstream`

const startedAt = new Date().toISOString()
const MAX_BODY_BYTES = 10_000_000

// ---------------------------------------------------------------------------
// Route table (derived from openapi-v2.json)
// ---------------------------------------------------------------------------

const spec = JSON.parse(fs.readFileSync(OPENAPI_FILE, 'utf8'))

/** Builds a regex that matches one path template (`/chats/{chatId}/...`). */
function compilePath(template) {
  const params = []
  const re = template
    .split('/')
    .filter(Boolean)
    .map((segment) => {
      const match = /^\{([^}]+)\}$/.exec(segment)
      if (match) {
        params.push(match[1])
        return '([^/]+)'
      }
      return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    })
    .join('/')
  return { regex: new RegExp(`^/${re}/?$`), params }
}

const routes = []
for (const [routePath, ops] of Object.entries(spec.paths || {})) {
  for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
    const op = ops[method]
    if (!op) continue
    routes.push({
      method: method.toUpperCase(),
      template: routePath,
      operationId: op.operationId,
      ...compilePath(routePath),
    })
  }
}

function matchRoute(method, pathname) {
  for (const route of routes) {
    if (route.method !== method) continue
    const m = route.regex.exec(pathname)
    if (m) {
      const params = {}
      route.params.forEach((name, i) => {
        try {
          params[name] = decodeURIComponent(m[i + 1])
        } catch {
          params[name] = m[i + 1]
        }
      })
      return { route, params }
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Validation (subset of the contract's required fields; checked before the
// handler runs so malformed requests get a conformant 422).
// ---------------------------------------------------------------------------

const REQUIRED_FIELDS = {
  'chats.create': ['message'],
  'chats.createAsync': ['message'],
  'chats.createStream': ['message'],
  'chats.createFromRepo': ['repo'],
  'chats.createFromFiles': ['files'],
  'chats.createFromZip': ['url'],
  'chats.restoreMessage': ['messageId'],
  'messages.send': ['message'],
  'messages.sendAsync': ['message'],
  'messages.sendStream': ['message'],
  'messages.resolve': ['task'],
  'messages.resolveAsync': ['task'],
  'messages.resolveStream': ['task'],
  'mcpServers.create': ['name', 'url'],
  'webhooks.create': ['name', 'events', 'url'],
}

const REQUIRED_QUERY = {
  'messages.list': ['limit'],
  'chats.getConnectStatus': ['requestId'],
}

const NESTED_REQUIRED_FIELDS = {
  'chats.createFromRepo': { repo: ['url'] },
}

function validateRequest(operationId, body) {
  const required = REQUIRED_FIELDS[operationId]
  if (required) {
    for (const field of required) {
      const value = body[field]
      if (value === undefined || value === null || value === '') {
        return `${field} is required`
      }
    }
  }
  const nested = NESTED_REQUIRED_FIELDS[operationId]
  if (nested) {
    for (const [parent, children] of Object.entries(nested)) {
      const parentValue = body[parent]
      if (parentValue === undefined || parentValue === null) continue
      if (typeof parentValue !== 'object' || Array.isArray(parentValue)) {
        return `${parent} must be an object`
      }
      for (const child of children) {
        const value = parentValue[child]
        if (value === undefined || value === null || value === '') {
          return `${parent}.${child} is required`
        }
      }
    }
  }
  return null
}

function validateQuery(operationId, query) {
  const required = REQUIRED_QUERY[operationId]
  if (required) {
    for (const field of required) {
      const value = query[field]
      if (value === undefined || value === null || value === '') {
        return `${field} is required`
      }
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

function isLocalhost(address) {
  return (
    address === '127.0.0.1' ||
    address === '::1' ||
    address === '::ffff:127.0.0.1'
  )
}

function isAuthorized(req) {
  if (!TOKEN) return true
  const address = req.socket?.remoteAddress || ''
  if (isLocalhost(address)) return true
  const header = req.headers['authorization'] || ''
  const bearer = /^Bearer\s+(.+)$/i.exec(header)
  return Boolean(bearer && bearer[1] === TOKEN)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sendJson(res, statusCode, data, extraHeaders = {}) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  })
  res.end(data === undefined ? undefined : JSON.stringify(data))
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > MAX_BODY_BYTES) {
        reject(new Error('body_too_large'))
        req.destroy()
      }
    })
    req.on('end', () => {
      if (!body.trim()) return resolve({})
      try {
        resolve(JSON.parse(body))
      } catch {
        reject(new Error('invalid_json'))
      }
    })
    req.on('error', reject)
  })
}

/** Dispatches implemented operations; unimplemented ones return 501. */
const STREAM_OPS = {
  'chats.createStream': streamHandlers.chatsCreateStream,
  'messages.sendStream': streamHandlers.messagesSendStream,
  'chats.resume': streamHandlers.chatsResume,
  'messages.resolveStream': streamHandlers.messagesResolveStream,
}

/**
 * App-side envelope routes for the `@v0-sdk/react` `V0Transport`. These are
 * NOT part of the public v2 spec (openapi-v2.json is the raw-event contract);
 * they mirror v0's own caller-owned proxy routes, which emit a full
 * `V0StreamUpdate` envelope per SSE frame plus a trailing `done` frame.
 */
function matchAIStreamRoute(method, inner) {
  if (method !== 'POST') return null
  if (inner === '/ai/chats/stream') {
    return { operationId: 'ai.chats.createStream', handler: streamHandlers.chatsCreateStreamAI, params: {} }
  }
  let m = /^\/ai\/chats\/([^/]+)\/messages\/stream$/.exec(inner)
  if (m) {
    return { operationId: 'ai.messages.sendStream', handler: streamHandlers.messagesSendStreamAI, params: { chatId: m[1] } }
  }
  m = /^\/ai\/chats\/([^/]+)\/resume$/.exec(inner)
  if (m) {
    return { operationId: 'ai.chats.resume', handler: streamHandlers.chatsResumeAI, params: { chatId: m[1] } }
  }
  return null
}

const JSON_OPS = {
  'chats.create': chatHandlers.chatsCreate,
  'chats.createAsync': chatHandlers.chatsCreateAsync,
  'chats.list': chatHandlers.chatsList,
  'chats.get': chatHandlers.chatsGet,
  'chats.update': chatHandlers.chatsUpdate,
  'chats.delete': chatHandlers.chatsDelete,
  'chats.duplicate': chatHandlers.chatsDuplicate,
  'chats.restoreMessage': chatHandlers.chatsRestoreMessage,
  'chats.createFromFiles': chatHandlers.chatsCreateFromFiles,
  'chats.createFromZip': chatHandlers.chatsCreateFromZip,
  'chats.createFromRepo': chatHandlers.chatsCreateFromRepo,
  'chats.getFiles': chatHandlers.chatsGetFiles,
  'chats.updateFiles': chatHandlers.chatsUpdateFiles,
  'chats.downloadFiles': chatHandlers.chatsDownloadFiles,
  'chats.getConnectStatus': chatHandlers.chatsGetConnectStatus,
  'chats.createVercelProject': chatHandlers.chatsCreateVercelProject,
  'chats.deploy': chatHandlers.chatsDeploy,
  'chats.getPreview': metaHandlers.chatsGetPreview,
  'messages.list': chatHandlers.messagesList,
  'messages.send': chatHandlers.messagesSend,
  'messages.sendAsync': chatHandlers.messagesSendAsync,
  'messages.get': chatHandlers.messagesGet,
  'messages.stop': chatHandlers.messagesStop,
  'messages.resolve': chatHandlers.messagesResolve,
  'messages.resolveAsync': chatHandlers.messagesResolveAsync,
  'mcpServers.create': metaHandlers.mcpServersCreate,
  'mcpServers.list': metaHandlers.mcpServersList,
  'mcpServers.get': metaHandlers.mcpServersGet,
  'mcpServers.update': metaHandlers.mcpServersUpdate,
  'mcpServers.delete': metaHandlers.mcpServersDelete,
  'webhooks.create': metaHandlers.webhooksCreate,
  'webhooks.list': metaHandlers.webhooksList,
  'webhooks.get': metaHandlers.webhooksGet,
  'webhooks.update': metaHandlers.webhooksUpdate,
  'webhooks.delete': metaHandlers.webhooksDelete,
  'settings.getPreviewHosts': metaHandlers.settingsGetPreviewHosts,
  'settings.setPreviewHosts': metaHandlers.settingsSetPreviewHosts,
}

async function handleOperation({ route, params, body, query }) {
  const op = STREAM_OPS[route.operationId] || JSON_OPS[route.operationId]
  if (op) return op({ params, body, query })
  return {
    status: 501,
    json: { message: `not_implemented:${route.operationId}` },
  }
}

/** Fires lifecycle webhook events after successful JSON mutations. */
function emitForOperation(operationId, json) {
  switch (operationId) {
    case 'chats.create':
    case 'chats.createAsync':
    case 'chats.createFromFiles':
    case 'chats.createFromZip':
    case 'chats.createFromRepo':
    case 'chats.duplicate': {
      const chat = json && (json.chat || (json.id ? json : null))
      if (chat && chat.id) webhooks.emitWebhookEvent('chat.created', chat)
      break
    }
    case 'chats.update': {
      if (json && json.id) webhooks.emitWebhookEvent('chat.updated', json)
      break
    }
    case 'chats.delete': {
      if (json && json.chatId) webhooks.emitWebhookEvent('chat.deleted', json)
      break
    }
    case 'messages.send':
    case 'messages.sendAsync': {
      if (json && json.id) webhooks.emitWebhookEvent('message.finished', json)
      break
    }
  }
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

async function handle(req, res) {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
  const pathname = url.pathname

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    })
    return res.end()
  }

  if (req.method === 'GET' && pathname === '/health') {
    sendJson(res, 200, {
      status: 'ok',
      service: 'nexos-api',
      version: process.env.npm_package_version || '0.1.0',
      startedAt,
      uptimeSeconds: Math.round(process.uptime()),
      auth: Boolean(TOKEN),
      base: '/v2',
      operations: routes.length,
    })
    return
  }

  // The v2 surface is mounted under /v2, mirroring https://api.v0.dev/v2.
  if (pathname === '/v2' || pathname.startsWith('/v2/')) {
    const inner = pathname.slice(3).replace(/\/$/, '') || '/'
    if (!isAuthorized(req)) {
      sendJson(res, 401, { message: 'Unauthorized' })
      return
    }
    const ai = matchAIStreamRoute(req.method, inner)
    if (ai) {
      const body = ['POST', 'PUT', 'PATCH'].includes(req.method)
        ? await parseJsonBody(req)
        : {}
      const query = Object.fromEntries(url.searchParams.entries())
      const result = ai.handler({ params: ai.params, body, query })
      if (typeof result.stream === 'function') {
        await result.stream(res)
        return
      }
      if (result.status >= 200 && result.status < 300) {
        emitForOperation(ai.operationId, result.json)
      }
      sendJson(res, result.status, result.json)
      return
    }
    const match = matchRoute(req.method, inner)
    if (!match) {
      sendJson(res, 404, { message: 'route_not_found' })
      return
    }
    const body = ['POST', 'PUT', 'PATCH'].includes(req.method)
      ? await parseJsonBody(req)
      : {}
    const query = Object.fromEntries(url.searchParams.entries())
    const problem = validateRequest(match.route.operationId, body)
    if (problem) {
      sendJson(res, 422, { message: problem })
      return
    }
    const queryProblem = validateQuery(match.route.operationId, query)
    if (queryProblem) {
      sendJson(res, 422, { message: queryProblem })
      return
    }
    const result = await handleOperation({ route: match.route, params: match.params, body, query })
    if (typeof result.stream === 'function') {
      await result.stream(res)
      return
    }
    if (result.status >= 200 && result.status < 300) {
      emitForOperation(match.route.operationId, result.json)
    }
    sendJson(res, result.status, result.json)
    return
  }

  sendJson(res, 404, { message: 'route_not_found' })
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    const status = err.message === 'invalid_json' ? 400 : err.message === 'body_too_large' ? 413 : 400
    sendJson(res, status, { message: err.message })
  })
})

server.on('error', (err) => {
  console.error(`[nexos:api] server error: ${err.message}`)
  process.exit(1)
})

const previewServer = createPreviewServer({
  stateDir: STATE_DIR,
  secret: PREVIEW_SECRET,
  forwardBase: PREVIEW_UPSTREAM,
})

previewServer.on('error', (err) => {
  console.error(`[nexos:api] preview server error: ${err.message}`)
  process.exit(1)
})

function shutdown() {
  server.close(() => process.exit(0))
  previewServer.close()
  setTimeout(() => process.exit(0), 1000).unref()
}

server.listen(PORT, HOST, () => {
  fs.mkdirSync(STATE_DIR, { recursive: true })
  store.initStore({ dir: STATE_DIR })
  webhooks.initWebhooks({ dir: STATE_DIR })
  const persisted = store.listChats({ limit: 1000 }).chats.length
  console.log(`[nexos:api] v2 API gateway on ${HOST}:${PORT} (${routes.length} operations from ${path.basename(OPENAPI_FILE)})${TOKEN ? ' (auth enabled)' : ' (no auth)'}`)
  console.log(`[nexos:api] state dir: ${STATE_DIR} (${persisted} chats loaded)`)
  previewServer.listen(PREVIEW_PORT, PREVIEW_HOST, () => {
    const upstream = PREVIEW_UPSTREAM.includes('/_upstream') ? 'mock files upstream' : PREVIEW_UPSTREAM
    console.log(`[nexos:api] preview ingress on ${PREVIEW_HOST}:${PREVIEW_PORT} (${upstream})`)
  })
})

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
