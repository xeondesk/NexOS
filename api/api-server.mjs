// NexOS v0-compatible API gateway (Phase 2: CRUD + persistence).
//
// Implements the v0.app production API v2 contract served at
// https://api.v0.dev/v2. The route table is derived at startup from
// `api/openapi-v2.json` (a copy of vercel/v0-sdk's openapi.json, Apache-2.0,
// https://github.com/vercel/v0-sdk) so the mounted surface can never drift
// from the spec. Phase 1 added the streaming ops (`chats.createStream`,
// `messages.sendStream`, `chats.resume`) on a deterministic mock backend.
// Phase 2 adds chat/message CRUD + async variants + from-files/zip/repo,
// persisted atomically under NEXOS_API_STATE_DIR (see api/lib/chat-store.mjs).
// Remaining operations return 501 until the phased plan implements them
// (previews, MCP servers, webhooks next).
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
//   NEXOS_API_STATE_DIR  persistence dir for chat/message state (Phase 2)

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as store from './lib/chat-store.mjs'
import * as streamHandlers from './lib/stream-handlers.mjs'
import * as chatHandlers from './lib/chat-handlers.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const PORT = parseInt(process.env.NEXOS_API_PORT || '8081', 10)
const allowRemote = (process.env.NEXOS_ALLOW_REMOTE || '') === 'true'
const HOST = process.env.NEXOS_API_HOST || (allowRemote ? '0.0.0.0' : '127.0.0.1')
const TOKEN = process.env.NEXOS_API_TOKEN || ''
const STATE_DIR = process.env.NEXOS_API_STATE_DIR || path.join(ROOT, 'state', 'api')
const OPENAPI_FILE = path.join(__dirname, 'openapi-v2.json')

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
  'mcpServers.create': ['name', 'url'],
  'webhooks.create': ['name', 'events', 'url'],
}

const REQUIRED_QUERY = {
  'messages.list': ['limit'],
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
  res.end(data === undefined || data === null ? undefined : JSON.stringify(data))
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
  'messages.list': chatHandlers.messagesList,
  'messages.send': chatHandlers.messagesSend,
  'messages.sendAsync': chatHandlers.messagesSendAsync,
  'messages.get': chatHandlers.messagesGet,
  'messages.stop': chatHandlers.messagesStop,
}

async function handleOperation({ route, params, body, query }) {
  const op = STREAM_OPS[route.operationId] || JSON_OPS[route.operationId]
  if (op) return op({ params, body, query })
  return {
    status: 501,
    json: { message: `not_implemented:${route.operationId}` },
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

function shutdown() {
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 1000).unref()
}

server.listen(PORT, HOST, () => {
  fs.mkdirSync(STATE_DIR, { recursive: true })
  store.initStore({ dir: STATE_DIR })
  const persisted = store.listChats({ limit: 1000 }).chats.length
  console.log(`[nexos:api] v2 API gateway on ${HOST}:${PORT} (${routes.length} operations from ${path.basename(OPENAPI_FILE)})${TOKEN ? ' (auth enabled)' : ' (no auth)'}`)
  console.log(`[nexos:api] state dir: ${STATE_DIR} (${persisted} chats loaded)`)
})

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
