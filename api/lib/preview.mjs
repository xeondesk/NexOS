// NexOS v0-compatible API gateway (Phase 3): preview ingress.
//
// Port of `v0-sdk`'s `preview-proxy.ts` (Apache-2.0) to node:http, plus the
// pieces that make previews usable self-hosted:
//
//   - chats.getPreview returns `{ url, token, expiresAt }` where `url` points at
//     this ingress (`NEXOS_PREVIEW_PORT`) and `token` is an HMAC-signed,
//     chat-scoped, expiring value accepted via the `x-v0-preview-token` header
//     (SDK style) or a `?token=` query (direct iframe embedding).
//   - The ingress forwards each request to the chat's preview origin with the
//     token attached, stripping hop-by-hop/proxy headers, refusing cross-origin
//     path resolution, honoring `x-v0-preview-refresh: 1` with a fallback
//     redirect, and pinning the response to `private, no-store` — exactly the
//     fetchPreview semantics.
//   - The default upstream is an internal mock static server that serves the
//     chat's ingested files (state/api/files/<chatId>.json); set
//     `NEXOS_PREVIEW_UPSTREAM` to a real dev server (next/vite) instead.
//
// Mock-only extension: appending `?__refresh=1` to a mock-upstream URL makes it
// answer `x-v0-preview-refresh: 1` so the refresh path is testable.

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { Readable } from 'node:stream'

export const PREVIEW_TOKEN_TTL_MS = 30 * 60 * 1000

const previewRefreshHeader = 'x-v0-preview-refresh'
const previewTokenHeader = 'x-v0-preview-token'
const privateNoStore = 'private, no-store'

const hopByHopHeaders = [
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]

const strippedRequestHeaders = new Set([
  ...hopByHopHeaders,
  'authorization',
  'content-length',
  'cookie',
  'forwarded',
  'host',
  'via',
  'x-real-ip',
])

const strippedRequestHeaderPrefixes = ['x-envoy-', 'x-forwarded-', 'x-now-', 'x-vercel-']

const strippedResponseHeaders = [
  ...hopByHopHeaders,
  'age',
  'cache-status',
  'cdn-cache-control',
  'cf-cache-status',
  'content-encoding',
  'content-length',
  'expires',
  'set-cookie',
  'surrogate-control',
  'vercel-cdn-cache-control',
  'x-vercel-cache',
]

// ---------------------------------------------------------------------------
// Token signing
// ---------------------------------------------------------------------------

function base64url(input) {
  return Buffer.from(input).toString('base64url')
}

function hmac(secret, data) {
  return crypto.createHmac('sha256', secret).update(data).digest('base64url')
}

/** Signs a chat-scoped preview token valid until `now + TTL`. */
export function signPreviewToken(chatId, secret, now = Date.now(), ttlMs = PREVIEW_TOKEN_TTL_MS) {
  const expiresAt = now + ttlMs
  const payload = `${chatId}:${expiresAt}`
  return `${base64url(payload)}.${hmac(secret, payload)}`
}

/** Verifies a token's signature, expiry, and chat scope. */
export function verifyPreviewToken(chatId, token, secret, now = Date.now()) {
  if (!token) return false
  const [encoded, sig] = String(token).split('.')
  if (!encoded || !sig) return false
  let payload
  try {
    payload = Buffer.from(encoded, 'base64url').toString('utf8')
  } catch {
    return false
  }
  const [tokenChatId, expiresAtStr] = payload.split(':')
  if (tokenChatId !== chatId) return false
  const expiresAt = Number(expiresAtStr)
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return false
  const expected = hmac(secret, payload)
  const a = Buffer.from(expected)
  const b = Buffer.from(sig)
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

// ---------------------------------------------------------------------------
// Path / header handling (port of preview-proxy.ts)
// ---------------------------------------------------------------------------

/** Neutralizes scheme-relative / path-traversal prefixes; always origin-rooted. */
function normalizePreviewPath(rest) {
  if (Array.isArray(rest)) {
    return `/${rest.map((segment) => encodeURIComponent(String(segment))).join('/')}`
  }
  return `/${String(rest || '').replace(/^[\s/\\]+/, '')}`
}

/** Joins a base URL pathname with a normalized relative path under one origin. */
function buildUpstreamUrl(base, rest, search) {
  const url = new URL(base)
  const path = normalizePreviewPath(rest)
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`
  url.search = search || ''
  return url
}

function stripRequestHeaders(headers, token) {
  const out = {}
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase()
    if (strippedRequestHeaders.has(lower)) continue
    if (strippedRequestHeaderPrefixes.some((prefix) => lower.startsWith(prefix))) continue
    out[name] = value
  }
  out[previewTokenHeader] = token
  return out
}

function stripResponseHeaders(headers) {
  const out = {}
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase()
    if (strippedResponseHeaders.includes(lower)) continue
    out[name] = value
  }
  out['cache-control'] = privateNoStore
  return out
}

// ---------------------------------------------------------------------------
// Mock upstream: serves the chat's ingested files as a tiny static site.
// ---------------------------------------------------------------------------

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.map': 'application/json',
}

function contentType(filePath) {
  return CONTENT_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream'
}

function readChatFiles(stateDir, chatId) {
  try {
    const raw = fs.readFileSync(path.join(stateDir, 'files', `${chatId}.json`), 'utf8')
    const record = JSON.parse(raw)
    return Array.isArray(record.files) ? record.files : []
  } catch {
    return []
  }
}

function decodeFileContent(file) {
  if (file.encoding === 'base64') {
    return Buffer.from(String(file.content || ''), 'base64')
  }
  return Buffer.from(String(file.content ?? ''), 'utf8')
}

function autoIndex(files) {
  const rows = files
    .map((f) => `<li><a href="/${f.path}">${f.path}</a></li>`)
    .join('\n')
  return Buffer.from(
    `<!doctype html><html><head><meta charset="utf-8"><title>NexOS preview</title></head>` +
      `<body><h1>NexOS preview</h1><ul>\n${rows || '<li><em>(no files yet)</em></li>'}</ul></body></html>`,
    'utf8'
  )
}

function serveMockUpstream(stateDir, chatId, urlPath, res) {
  if (urlPath === '/') {
    const files = readChatFiles(stateDir, chatId)
    const index = files.find((f) => f.path === 'index.html')
    const body = index ? decodeFileContent(index) : autoIndex(files)
    const type = index ? 'text/html; charset=utf-8' : 'text/html; charset=utf-8'
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' })
    return res.end(body)
  }
  const name = urlPath.replace(/^\/+/, '')
  const file = readChatFiles(stateDir, chatId).find((f) => f.path === name)
  if (!file) {
    res.writeHead(404, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    return res.end(JSON.stringify({ message: 'file_not_found' }))
  }
  res.writeHead(200, { 'Content-Type': contentType(name), 'Cache-Control': 'no-store' })
  res.end(decodeFileContent(file))
}

// ---------------------------------------------------------------------------
// Ingress server
// ---------------------------------------------------------------------------

function writeUpstreamResponse(upstreamRes, target, res) {
  const status = upstreamRes.status
  if (upstreamRes.headers.get(previewRefreshHeader) === '1') {
    res.writeHead(302, {
      'cache-control': privateNoStore,
      location: `/_loading?from=${encodeURIComponent(target.pathname)}`,
    })
    return res.end()
  }
  const headers = stripResponseHeaders(Object.fromEntries(upstreamRes.headers.entries()))
  res.writeHead(status, headers)
  if (!upstreamRes.body) return res.end()
  Readable.fromWeb(upstreamRes.body).pipe(res)
}

/**
 * Builds the preview ingress server. `forwardBase` is the upstream preview
 * origin base URL for a chat (mock or real); the ingress only ever forwards to
 * that same origin. Call `.listen()` separately.
 */
export function createPreviewServer({ stateDir, secret, forwardBase }) {
  const mockOrigin = new URL(forwardBase).origin
  const mockUpstream = String(forwardBase).includes('/_upstream/')

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (res.headersSent) return res.destroy()
      res.writeHead(500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify({ message: String(err.message || err) }))
    })
  })

  async function handle(req, res) {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
    const parts = url.pathname.split('/').filter(Boolean)
    const [first, ...rest] = parts
    const restPath = rest.length ? `/${rest.join('/')}` : '/'

    if (first === '_loading') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
      return res.end('<!doctype html><html><body><h1>NexOS preview</h1><p>Preview is starting&hellip;</p><script>setTimeout(()=>location.reload(),1500)</script></body></html>')
    }

    if (first === '_upstream') {
      const [, chatId, ...inner] = parts
      if (!chatId || !chatId.startsWith('chat_')) {
        res.writeHead(404, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
        return res.end(JSON.stringify({ message: 'chat_not_found' }))
      }
      // Mock hook: force x-v0-preview-refresh so the refresh path is testable.
      if (url.searchParams.get('__refresh') === '1') {
        res.setHeader(previewRefreshHeader, '1')
        res.writeHead(200, { 'Cache-Control': 'no-store' })
        return res.end()
      }
      return serveMockUpstream(stateDir, chatId, inner.length ? `/${inner.join('/')}` : '/', res)
    }

    // Protected ingress: /<chatId>/<path>...
    if (!first || !first.startsWith('chat_')) {
      res.writeHead(404, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      return res.end(JSON.stringify({ message: 'route_not_found' }))
    }
    const chatId = first
    const token = req.headers[previewTokenHeader] || url.searchParams.get('token') || ''
    if (!verifyPreviewToken(chatId, token, secret)) {
      res.writeHead(403, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      return res.end(JSON.stringify({ message: 'invalid_preview_token' }))
    }

    const base = mockUpstream
      ? `${mockOrigin}/_upstream/${chatId}`
      : `${forwardBase.replace(/\/+$/, '')}/${chatId}`
    const search = new URLSearchParams(url.search)
    search.delete('token')
    const target = buildUpstreamUrl(base, restPath, search.toString())
    if (target.origin !== mockOrigin && target.origin !== new URL(base).origin) {
      throw new Error('Preview path resolved to a different origin than the preview URL.')
    }

    const hasBody = req.method !== 'GET' && req.method !== 'HEAD'
    const upstreamRes = await fetch(target, {
      method: req.method,
      headers: stripRequestHeaders(req.headers, token),
      body: hasBody ? Buffer.from(await readBody(req)) : undefined,
      redirect: 'manual',
      cache: 'no-store',
    })
    writeUpstreamResponse(upstreamRes, target, res)
  }

  return server
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/** Builds the `chats.getPreview` payload for a chat with files. */
export function makePreview(chatId, { host, port, secret, now = Date.now() } = {}) {
  const expiresAt = new Date(now + PREVIEW_TOKEN_TTL_MS).toISOString()
  return {
    url: `http://${host}:${port}/${chatId}/`,
    token: signPreviewToken(chatId, secret, now),
    expiresAt,
  }
}
