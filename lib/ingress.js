// NexOS agent-browser ingress — single-port reverse proxy.
//
// Replaces the platform-owned `VSCODE_PROXY_URI=/proxy/{{port}}/` + wildcard
// hostname ingress (ARCHITECTURE.md gap A2; MIGRATION-REPORT.md §8 future work).
// One dependency-free node:http server, two routing schemes:
//
//   1. Path scheme (v0 parity):  /proxy/<port>/<path> -> http://127.0.0.1:<port>/<path>
//      Numeric port 1-65535 only (loopback targets -> SSRF-safe by construction).
//   2. Host scheme:              Host: <sub>.nexos.build -> mapped upstream
//      (`NEXOS_INGRESS_ROUTES`); numeric subdomain `<port>.nexos.build` -> the
//      loopback port. Defaults match the `NEXOS_ALLOWED_DEV_HOSTS` framework
//      hooks (lib/config-loader.mjs) so a hostname the framework accepts is one
//      the ingress serves.
//
// Forwarding follows the preview ingress semantics (api/lib/preview.mjs): drop
// hop-by-hop + proxy headers, rewrite Host, stream bodies without buffering
// (SSE-safe), and pass WebSocket `upgrade` through for `next dev` HMR / server
// actions.
//
// Configuration (NEXOS_* env vars):
//   NEXOS_INGRESS_PORT    listening port (default 8083)
//   NEXOS_INGRESS_HOST    bind host (default 127.0.0.1; 0.0.0.0 when
//                         NEXOS_ALLOW_REMOTE=true)
//   NEXOS_INGRESS_TOKEN   optional bearer for remote clients. Loopback is always
//                         trusted; unset = no auth. WebSocket clients (which
//                         cannot set headers) may send it as `?token=`.
//   NEXOS_INGRESS_ROUTES  JSON host->upstream map; `*.` prefix matches any
//                         subdomain. Default:
//                         {"*.nexos.build":"http://127.0.0.1:3000",
//                          "*.nexos.run":"http://127.0.0.1:4444",
//                          "*.nexos.net":"http://127.0.0.1:7681"}

const http = require('http')
const { URL } = require('url')

const PORT = parseInt(process.env.NEXOS_INGRESS_PORT || '8083', 10)
const allowRemote = (process.env.NEXOS_ALLOW_REMOTE || '') === 'true'
const HOST = process.env.NEXOS_INGRESS_HOST || (allowRemote ? '0.0.0.0' : '127.0.0.1')
const TOKEN = process.env.NEXOS_INGRESS_TOKEN || ''
const ROUTES = parseRoutes(process.env.NEXOS_INGRESS_ROUTES)

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
  'forwarded',
  'host',
  'via',
  'x-real-ip',
])

const strippedRequestHeaderPrefixes = ['x-envoy-', 'x-forwarded-', 'x-now-', 'x-vercel-']

function parseRoutes(raw) {
  if (!raw) {
    return {
      '*.nexos.build': 'http://127.0.0.1:3000',
      '*.nexos.run': 'http://127.0.0.1:4444',
      '*.nexos.net': 'http://127.0.0.1:7681',
    }
  }
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
  } catch {
    /* fall through to empty map */
  }
  return {}
}

// ---------------------------------------------------------------------------
// Auth (same model as web/api-server.js / api/api-server.mjs)
// ---------------------------------------------------------------------------

function isLocalhost(address) {
  return (
    address === '127.0.0.1' ||
    address === '::1' ||
    address === '::ffff:127.0.0.1'
  )
}

function isAuthorized(req, token = TOKEN) {
  if (!token) return true
  const address = req.socket?.remoteAddress || ''
  if (isLocalhost(address)) return true
  const header = req.headers['authorization'] || ''
  const bearer = /^Bearer\s+(.+)$/i.exec(header)
  if (bearer && bearer[1] === token) return true
  const url = new URL(req.url || '/', 'http://localhost')
  return url.searchParams.get('token') === token
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

/** Strips the client-facing port from a Host header value. */
function hostnameOf(host) {
  return String(host || '').split(':')[0].toLowerCase()
}

/**
 * Resolves an incoming request to a loopback target URL. Returns
 * `{ target, token }` on success or `{ error: <status> }`.
 */
function routeRequest(req, routes = ROUTES) {
  const url = new URL(req.url || '/', 'http://localhost')
  const token = url.searchParams.get('token')

  // Path scheme (v0 VSCODE_PROXY_URI parity): /proxy/<port>/<path>
  const m = /^\/proxy\/(\d{1,5})(\/.*)?$/.exec(url.pathname)
  if (m) {
    const port = Number(m[1])
    if (port < 1 || port > 65535) return { error: 400 }
    const rest = m[2] || '/'
    url.searchParams.delete('token')
    return { target: `http://127.0.0.1:${port}${rest}${url.search}`, token }
  }

  // Host scheme: <sub>.<domain> matched against the route map. Numeric
  // subdomains are a NexOS convenience: <port>.nexos.build -> loopback port
  // (checked first so a numeric subdomain never collides with a named route).
  // IP-literal hosts (e.g. 127.0.0.1) never take the numeric-subdomain path.
  const host = hostnameOf(req.headers.host)
  const dot = host.indexOf('.')
  if (dot > 0) {
    const sub = host.slice(0, dot)
    const base = host.slice(dot + 1)
    const isIpLiteral = /^\d+(\.\d+)+$/.test(host)
    let upstream = !isIpLiteral && /^\d+$/.test(sub) && Number(sub) >= 1 && Number(sub) <= 65535
      ? `http://127.0.0.1:${Number(sub)}`
      : routes[`*.${base}`]
    if (upstream) {
      const baseUrl = new URL(upstream)
      url.searchParams.delete('token')
      baseUrl.pathname = url.pathname
      baseUrl.search = url.search
      return { target: baseUrl.toString(), token }
    }
  }
  return { error: 404 }
}

// ---------------------------------------------------------------------------
// Header hygiene
// ---------------------------------------------------------------------------

function cleanRequestHeaders(headers, upstreamHost, clientAddress) {
  const out = {}
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase()
    if (strippedRequestHeaders.has(lower)) continue
    if (strippedRequestHeaderPrefixes.some((prefix) => lower.startsWith(prefix))) continue
    out[name] = value
  }
  out.host = upstreamHost
  out['x-forwarded-for'] = clientAddress
  out['x-forwarded-proto'] = 'http'
  return out
}

const strippedResponseHeaders = new Set([
  ...hopByHopHeaders,
  'age',
  'cache-status',
  'cf-cache-status',
  'proxy-authenticate',
  'proxy-authorization',
  'set-cookie',
  'surrogate-control',
  'x-vercel-cache',
])

function cleanResponseHeaders(headers) {
  const out = {}
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase()
    if (strippedResponseHeaders.has(lower)) continue
    out[name] = value
  }
  return out
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

/**
 * Builds the ingress server. Call `.listen()` separately (pass port/host
 * there). `{ token, routes }` override the env-derived defaults (used by
 * tests); anything unset falls back to the process environment.
 */
function createIngressServer(overrides = {}) {
  const token = overrides.token !== undefined ? overrides.token : TOKEN
  const routes = overrides.routes || ROUTES

  const server = http.createServer((req, res) => {
    handleRequest(req, res, token, routes).catch((err) => {
      if (res.headersSent) return res.destroy()
      res.writeHead(502, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ message: String(err.message || err) }))
    })
  })

  server.on('upgrade', (req, socket, head) => {
    handleUpgrade(req, socket, head, token, routes)
  })

  return server
}

async function handleRequest(req, res, token, routes) {
  if (!isAuthorized(req, token)) {
    res.writeHead(401, { 'Content-Type': 'application/json' })
    return res.end(JSON.stringify({ message: 'unauthorized' }))
  }
  const route = routeRequest(req, routes)
  if (route.error) {
    res.writeHead(route.error, { 'Content-Type': 'application/json' })
    return res.end(JSON.stringify({ message: 'route_not_found' }))
  }
  const target = new URL(route.target)
  const headers = cleanRequestHeaders(req.headers, target.host, req.socket.remoteAddress || '')
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD'

  const upstreamReq = http.request(
    target,
    {
      method: req.method,
      headers,
    },
    (upstreamRes) => {
      const status = upstreamRes.statusCode || 502
      res.writeHead(status, cleanResponseHeaders(upstreamRes.headers))
      upstreamRes.pipe(res)
    }
  )
  upstreamReq.on('error', (err) => {
    if (res.headersSent) return res.destroy()
    res.writeHead(502, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ message: String(err.message || err) }))
  })
  if (hasBody) {
    req.pipe(upstreamReq)
  } else {
    upstreamReq.end()
  }
}

function handleUpgrade(req, socket, head, token, routes) {
  if (!isAuthorized(req, token)) {
    socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n')
    return
  }
  const route = routeRequest(req, routes)
  if (route.error) {
    socket.end(`HTTP/1.1 ${route.error} Not Found\r\n\r\n`)
    return
  }
  const target = new URL(route.target)
  const headers = cleanRequestHeaders(req.headers, target.host, req.socket.remoteAddress || '')
  headers.connection = 'Upgrade'
  headers.upgrade = 'websocket'

  const upstreamReq = http.request(target, { method: 'GET', headers, agent: false })
  upstreamReq.on('upgrade', (upstreamRes, upstreamSocket, upstreamHead) => {
    // Forward the upstream 101 verbatim — the ws client validates
    // Upgrade/Connection/Sec-WebSocket-Accept against the handshake.
    socket.write('HTTP/1.1 101 Switching Protocols\r\n')
    for (const [name, value] of Object.entries(upstreamRes.headers)) {
      socket.write(`${name}: ${Array.isArray(value) ? value.join(', ') : value}\r\n`)
    }
    socket.write('\r\n')
    if (upstreamHead && upstreamHead.length) socket.write(upstreamHead)
    upstreamSocket.pipe(socket)
    socket.pipe(upstreamSocket)
    socket.on('error', () => upstreamSocket.destroy())
    upstreamSocket.on('error', () => socket.destroy())
    socket.on('close', () => upstreamSocket.destroy())
    upstreamSocket.on('close', () => socket.destroy())
  })
  upstreamReq.on('error', () => socket.destroy())
  upstreamReq.end()
}

// ---------------------------------------------------------------------------
// Main (supervised via bin/nexos start ingress)
// ---------------------------------------------------------------------------

if (require.main === module) {
  const server = createIngressServer()
  server.on('error', (err) => {
    console.error(`[nexos:ingress] server error: ${err.message}`)
    process.exit(1)
  })
  server.listen(PORT, HOST, () => {
    const mode = TOKEN ? ' (auth enabled)' : ' (no auth)'
    const routes = Object.keys(ROUTES).join(', ')
    console.log(`[nexos:ingress] agent-browser ingress on ${HOST}:${PORT}${mode}`)
    console.log(`[nexos:ingress] host routes: ${routes}; path routes: /proxy/<port>/`)
  })
  process.on('SIGTERM', () => server.close(() => process.exit(0)))
  process.on('SIGINT', () => server.close(() => process.exit(0)))
}

module.exports = { createIngressServer, routeRequest, isAuthorized }