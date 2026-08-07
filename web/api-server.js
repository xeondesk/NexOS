// NexOS Web platform portal API server.
//
// A dependency-free node:http server that fronts the NexOS platform for the
// browser dashboard (web/index.html). It aggregates the control plane instead
// of exposing raw ports: supervisor status, log history, exec, metrics, and
// git-sign/bridge health all sit behind a single /api/v1 surface with token
// auth and persisted dashboard settings.
//
// Backend services are never reached directly by the browser; this server
// proxies to them over loopback, where the log-proxy and bridge trust
// loopback clients (so no control-plane tokens are needed here by default).
//
// Configuration (NEXOS_* env vars):
//   NEXOS_WEB_PORT        listening port (default 8080)
//   NEXOS_WEB_HOST        bind host (default 127.0.0.1; 0.0.0.0 when
//                         NEXOS_ALLOW_REMOTE=true)
//   NEXOS_WEB_TOKEN       optional auth token. Loopback is always trusted;
//                         non-loopback requests must present it (Authorization:
//                         Bearer <token>) or a valid session cookie. Unset =
//                         no auth.
//   NEXOS_WEB_STATE_FILE  persisted dashboard settings snapshot
//   NEXOS_RUN_DIR         supervisor pidfile dir (default <root>/state/run)
//   NEXOS_LOG_PROXY_PORT  control-plane log/exec endpoint (default 7682)
//   NEXOS_BRIDGE_PORT     editor bridge (default 9876)
//   NEXOS_GIT_SIGN_PORT   git-sign health/pubkey (default 9877)
//   NEXOS_API_PORT        v2 API gateway loopback (default 8081)
//
// Endpoints:
//   GET  /                     -> web/index.html
//   GET  /health               -> liveness + backend dependency state
//   POST /api/v1/login         -> { token } -> sets session cookie
//   POST /api/v1/logout        -> clears session cookie
//   GET  /api/v1/status        -> supervisor + per-service health
//   GET  /api/v1/logs          -> log-proxy history (since, isAdmin)
//   POST /api/v1/exec          -> log-proxy execute (cmd, args, cwd, env, wait)
//   GET  /api/v1/metrics       -> system resource snapshot
//   GET  /api/v1/git-sign      -> git-sign health + pubkey
//   GET  /api/v1/bridge        -> editor bridge status
//   GET  /api/v1/settings      -> persisted dashboard settings
//   PUT  /api/v1/settings      -> persist dashboard settings
//   POST /api/v1/chat/stream   -> v2 chat turn (SSE) via the gateway envelope routes
//   POST /api/v1/chat/resume   -> resume last generation (SSE)

const http = require('http')
const fs = require('fs')
const path = require('path')
const os = require('os')
const crypto = require('crypto')
const { execFileSync } = require('child_process')

const ROOT = path.resolve(__dirname, '..')
const PORT = parseInt(process.env.NEXOS_WEB_PORT || '8080', 10)
const allowRemote = (process.env.NEXOS_ALLOW_REMOTE || '') === 'true'
const HOST = process.env.NEXOS_WEB_HOST || (allowRemote ? '0.0.0.0' : '127.0.0.1')
const TOKEN = process.env.NEXOS_WEB_TOKEN || ''
const STATE_FILE =
  process.env.NEXOS_WEB_STATE_FILE || path.join(ROOT, 'state', 'web-state.json')
const RUN_DIR = process.env.NEXOS_RUN_DIR || path.join(ROOT, 'state', 'run')
const LOG_PROXY_PORT = parseInt(process.env.NEXOS_LOG_PROXY_PORT || '7682', 10)
const BRIDGE_PORT = parseInt(process.env.NEXOS_BRIDGE_PORT || '9876', 10)
const GIT_SIGN_PORT = parseInt(process.env.NEXOS_GIT_SIGN_PORT || '9877', 10)
const API_PORT = parseInt(process.env.NEXOS_API_PORT || '8081', 10)
const INDEX_HTML = path.join(__dirname, 'index.html')

const SESSION_COOKIE = 'nexos_session'
const SESSION_TTL_MS = 12 * 60 * 60 * 1000
const MAX_BODY_BYTES = 1_000_000
const startedAt = new Date().toISOString()

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

function signSession(expiryEpoch) {
  const mac = crypto
    .createHmac('sha256', TOKEN)
    .update(`${expiryEpoch}`)
    .digest('base64url')
  return `${expiryEpoch}.${mac}`
}

function validSession(cookie) {
  if (!TOKEN || !cookie) return false
  const match = /^(\d+)\.([A-Za-z0-9_-]+)$/.exec(cookie)
  if (!match) return false
  const expiry = parseInt(match[1], 10)
  if (expiry < Date.now()) return false
  const mac = crypto
    .createHmac('sha256', TOKEN)
    .update(`${expiry}`)
    .digest('base64url')
  return mac === match[2]
}

function isAuthorized(req) {
  if (!TOKEN) return true
  const address = req.socket?.remoteAddress || ''
  if (isLocalhost(address)) return true
  const header = req.headers['authorization'] || ''
  const bearer = /^Bearer\s+(.+)$/i.exec(header)
  if (bearer && bearer[1] === TOKEN) return true
  const cookie = (req.headers['cookie'] || '')
    .split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${SESSION_COOKIE}=`))
  if (cookie) return validSession(cookie.split('=')[1])
  return false
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  res.end(JSON.stringify(data))
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

function proxyRequest(targetPort, method, targetPath, headers, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: targetPort,
        method,
        path: targetPath,
        headers,
        timeout: timeoutMs || 10000,
      },
      (res) => {
        let data = ''
        res.on('data', (chunk) => (data += chunk))
        res.on('end', () => resolve({ status: res.statusCode, data }))
      },
    )
    req.on('error', (err) => reject(err))
    req.on('timeout', () => {
      req.destroy(new Error('timeout'))
    })
    if (body !== undefined) req.write(body)
    req.end()
  })
}

/**
 * Streams an upstream response body to the browser without buffering (used for
 * the v2 chat SSE proxy). Forwards the upstream status + `content-type`, pipes
 * each chunk through, and tears down both sides on abort/error.
 */
function proxyStream(targetPort, method, targetPath, headers, body, res) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: targetPort,
        method,
        path: targetPath,
        headers,
      },
      (upstream) => {
        res.writeHead(upstream.statusCode || 502, {
          'Content-Type':
            upstream.headers['content-type'] || 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
          'X-Content-Type-Options': 'nosniff',
        })
        upstream.on('data', (chunk) => {
          if (!res.destroyed) res.write(chunk)
        })
        upstream.on('end', () => {
          if (!res.destroyed) res.end()
          resolve()
        })
        upstream.on('error', (err) => {
          if (!res.destroyed) res.destroy()
          reject(err)
        })
        req.on('close', () => upstream.destroy())
      },
    )
    req.on('error', (err) => {
      if (!res.destroyed) res.destroy()
      reject(err)
    })
    res.on('close', () => req.destroy())
    if (body !== undefined) req.write(body)
    req.end()
  })
}

function probeHealth(port, targetPath) {
  return proxyRequest(port, 'GET', targetPath || '/health', {}, undefined, 3000)
    .then((res) => ({ reachable: true, status: res.status, body: res.data }))
    .catch(() => ({ reachable: false, status: null, body: '' }))
}

// ---------------------------------------------------------------------------
// Supervisor status (mirrors `nexos status`)
// ---------------------------------------------------------------------------

function psCommand(pid) {
  try {
    return execFileSync('ps', ['-o', 'command=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch {
    return ''
  }
}

function supervisorStatus() {
  let entries
  try {
    entries = fs.readdirSync(RUN_DIR)
  } catch {
    return []
  }
  const services = []
  for (const name of entries) {
    if (!name.endsWith('.pid')) continue
    if (name.endsWith('.child.pid')) continue
    const serviceName = name.slice(0, -'.pid'.length)
    let pid = null
    try {
      pid = parseInt(fs.readFileSync(path.join(RUN_DIR, name), 'utf8'), 10)
    } catch {}
    let childPid = null
    try {
      childPid = parseInt(
        fs.readFileSync(path.join(RUN_DIR, `${serviceName}.child.pid`), 'utf8'),
        10,
      )
    } catch {}
    const running =
      pid !== null &&
      psCommand(pid).includes(`supervisor.sh run ${serviceName}`)
    services.push({
      name: serviceName,
      state: running ? 'running' : 'stale',
      pid,
      childPid,
    })
  }
  return services
}

// ---------------------------------------------------------------------------
// System metrics (same shape as lib/metrics.sh)
// ---------------------------------------------------------------------------

function memSnapshot() {
  let total = 0
  let available = 0
  try {
    const lines = fs.readFileSync('/proc/meminfo', 'utf8').split('\n')
    for (const line of lines) {
      const match = /^(\w+):\s+(\d+) kB/.exec(line)
      if (!match) continue
      if (match[1] === 'MemTotal') total = parseInt(match[2], 10)
      if (match[1] === 'MemAvailable') available = parseInt(match[2], 10)
    }
  } catch {}
  const memTotalMB = Math.round(total / 1024)
  const memAvailableMB = Math.round(available / 1024)
  const memUsedMB = memTotalMB - memAvailableMB
  const memUsedPercent =
    memTotalMB > 0 ? Math.round((memUsedMB * 100) / memTotalMB) : 0
  return { memTotalMB, memAvailableMB, memUsedMB, memUsedPercent }
}

function cpuSample() {
  try {
    const stat = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0]
    return stat
      .trim()
      .split(/\s+/)
      .slice(1)
      .map((n) => parseInt(n, 10) || 0)
  } catch {
    return []
  }
}

function cpuUsagePercent() {
  const c1 = cpuSample()
  const waitMs = 100
  const end = Date.now() + waitMs
  while (Date.now() < end) {
    // busy-wait keeps the sample interval accurate without a timer
  }
  const c2 = cpuSample()
  if (!c1.length || !c2.length) return 0
  const idle1 = c1[3] + c1[4]
  const idle2 = c2[3] + c2[4]
  const total1 = c1.reduce((a, b) => a + b, 0)
  const total2 = c2.reduce((a, b) => a + b, 0)
  const td = total2 - total1
  const id = idle2 - idle1
  if (td <= 0) return 0
  return Math.round(((td - id) * 1000) / td) / 10
}

function diskSnapshot() {
  try {
    const out = execFileSync('df', ['-BM', '/'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const parts = out.trim().split('\n').pop().split(/\s+/)
    const toMb = (s) => parseInt(String(s).replace('M', ''), 10) || 0
    const total = toMb(parts[1])
    const used = toMb(parts[2])
    return {
      diskTotalMB: total,
      diskUsedMB: used,
      diskUsedPercent: total > 0 ? Math.round((used * 100) / total) : 0,
    }
  } catch {
    return { diskTotalMB: 0, diskUsedMB: 0, diskUsedPercent: 0 }
  }
}

function metricsSnapshot() {
  const mem = memSnapshot()
  let load1m = 0
  let load5m = 0
  let load15m = 0
  try {
    const parts = fs.readFileSync('/proc/loadavg', 'utf8').trim().split(/\s+/)
    load1m = parseFloat(parts[0]) || 0
    load5m = parseFloat(parts[1]) || 0
    load15m = parseFloat(parts[2]) || 0
  } catch {}
  let hostUptimeSeconds = 0
  try {
    hostUptimeSeconds = Math.round(parseFloat(fs.readFileSync('/proc/uptime', 'utf8').trim().split(' ')[0]))
  } catch {}
  return {
    ...mem,
    loadAvg1m: load1m,
    loadAvg5m: load5m,
    loadAvg15m: load15m,
    cpuUsagePercent: cpuUsagePercent(),
    ...diskSnapshot(),
    hostname: os.hostname(),
    hostUptimeSeconds,
    at: new Date().toISOString(),
  }
}

// ---------------------------------------------------------------------------
// Dashboard settings persistence (atomic temp + rename)
// ---------------------------------------------------------------------------

let settings = {}
let loaded = false
let saveTimer = null

function loadSettings() {
  if (loaded) return
  loaded = true
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed.settings === 'object') settings = parsed.settings
  } catch {
    // missing or corrupt state file: start fresh
  }
}

function persistSettings() {
  const dir = path.dirname(STATE_FILE)
  try {
    fs.mkdirSync(dir, { recursive: true })
    const tmp = `${STATE_FILE}.tmp.${process.pid}`
    fs.writeFileSync(tmp, JSON.stringify({ savedAt: new Date().toISOString(), settings }, null, 2))
    fs.renameSync(tmp, STATE_FILE)
  } catch {
    // best-effort persistence
  }
}

function scheduleSave() {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(persistSettings, 40)
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

function serveIndex(req, res) {
  fs.readFile(INDEX_HTML, (err, data) => {
    if (err) {
      sendJson(res, 500, { error: 'index.html missing', message: err.message })
      return
    }
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    })
    res.end(data)
  })
}

async function handle(req, res) {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
  const pathname = url.pathname.replace(/\/$/, '') || '/'

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
    })
    return res.end()
  }

  if (req.method === 'GET' && pathname === '/health') {
    const [logProxy, bridge, gitSign, api] = await Promise.all([
      probeHealth(LOG_PROXY_PORT, '/health'),
      probeHealth(BRIDGE_PORT, '/status'),
      probeHealth(GIT_SIGN_PORT, '/health'),
      probeHealth(API_PORT, '/health'),
    ])
    sendJson(res, 200, {
      status: 'ok',
      service: 'nexos-web',
      version: process.env.npm_package_version || '0.1.0',
      startedAt,
      uptimeSeconds: Math.round(process.uptime()),
      auth: Boolean(TOKEN),
      dependencies: {
        logProxy: logProxy.reachable ? 'up' : 'down',
        bridge: bridge.reachable ? 'up' : 'down',
        gitSign: gitSign.reachable ? 'up' : 'down',
        api: api.reachable ? 'up' : 'down',
      },
    })
    return
  }

  if (req.method === 'GET' && pathname === '/') {
    return serveIndex(req, res)
  }

  if (req.method === 'POST' && pathname === '/api/v1/login') {
    if (!TOKEN) {
      sendJson(res, 200, { ok: true, message: 'auth disabled' })
      return
    }
    const body = await parseJsonBody(req)
    if (body.token !== TOKEN) {
      sendJson(res, 401, { error: 'invalid_token' })
      return
    }
    const expiry = Date.now() + SESSION_TTL_MS
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Set-Cookie': `${SESSION_COOKIE}=${signSession(expiry)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`,
    })
    res.end(JSON.stringify({ ok: true, expiresAt: expiry }))
    return
  }

  if (req.method === 'POST' && pathname === '/api/v1/logout') {
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Set-Cookie': `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`,
    })
    res.end(JSON.stringify({ ok: true }))
    return
  }

  if (!isAuthorized(req)) {
    sendJson(res, 401, { error: 'unauthorized', message: 'Authentication required.' })
    return
  }

  // --- chat (v2 envelope streaming proxy for the dashboard) ----------------
  // POST /api/v1/chat/stream  { message, chatId? } -> create or send turn
  // POST /api/v1/chat/resume  { chatId }           -> resume last generation
  // Both stream SSE back to the browser; the gateway's loopback is trusted so
  // no NEXOS_API_TOKEN is forwarded to the browser.
  if (req.method === 'POST' && pathname === '/api/v1/chat/stream') {
    const body = await parseJsonBody(req)
    if (typeof body.message !== 'string' || !body.message.trim()) {
      return sendJson(res, 400, { error: 'message is required' })
    }
    const targetPath = body.chatId
      ? `/v2/ai/chats/${encodeURIComponent(body.chatId)}/messages/stream`
      : '/v2/ai/chats/stream'
    try {
      await proxyStream(
        API_PORT,
        'POST',
        targetPath,
        { 'Content-Type': 'application/json' },
        JSON.stringify({ message: body.message }),
        res,
      )
    } catch (err) {
      if (!res.destroyed) {
        sendJson(res, 502, { error: 'api_unavailable', message: err.message })
      }
    }
    return
  }

  if (req.method === 'POST' && pathname === '/api/v1/chat/resume') {
    const body = await parseJsonBody(req)
    if (typeof body.chatId !== 'string' || !body.chatId) {
      return sendJson(res, 400, { error: 'chatId is required' })
    }
    try {
      await proxyStream(
        API_PORT,
        'POST',
        `/v2/ai/chats/${encodeURIComponent(body.chatId)}/resume`,
        {},
        undefined,
        res,
      )
    } catch (err) {
      if (!res.destroyed) {
        sendJson(res, 502, { error: 'api_unavailable', message: err.message })
      }
    }
    return
  }

  if (req.method === 'GET' && pathname === '/api/v1/status') {
    sendJson(res, 200, {
      supervisor: supervisorStatus(),
      services: {
        editor: { port: parseInt(process.env.NEXOS_EDITOR_PORT || '4444', 10) },
        terminal: { port: parseInt(process.env.NEXOS_TERMINAL_PORT || '7681', 10) },
      },
    })
    return
  }

  if (req.method === 'GET' && pathname === '/api/v1/logs') {
    try {
      const since = url.searchParams.get('since') || ''
      const isAdmin = url.searchParams.get('isAdmin') || ''
      const qs = []
      if (since) qs.push(`since=${encodeURIComponent(since)}`)
      if (isAdmin) qs.push('isAdmin=true')
      const result = await proxyRequest(
        LOG_PROXY_PORT,
        'GET',
        `/history${qs.length ? `?${qs.join('&')}` : ''}`,
        {},
        undefined,
      )
      if (result.status !== 200) {
        return sendJson(res, 502, { error: 'log_proxy_error', status: result.status })
      }
      const parsed = JSON.parse(result.data)
      sendJson(res, 200, { logs: parsed.logs || [], timestamp: parsed.timestamp })
    } catch (err) {
      sendJson(res, 503, { error: 'log_proxy_unavailable', message: err.message })
    }
    return
  }

  if (req.method === 'POST' && pathname === '/api/v1/exec') {
    const body = await parseJsonBody(req)
    if (typeof body.cmd !== 'string' || !body.cmd.trim()) {
      return sendJson(res, 400, { error: 'cmd is required' })
    }
    try {
      const result = await proxyRequest(
        LOG_PROXY_PORT,
        'POST',
        '/execute',
        { 'Content-Type': 'application/json' },
        JSON.stringify({
          cmd: body.cmd,
          args: body.args,
          cwd: body.cwd,
          env: body.env,
          wait: body.wait === true,
          blockId: body.blockId,
        }),
        120000,
      )
      let payload
      try {
        payload = JSON.parse(result.data)
      } catch {
        payload = { data: result.data }
      }
      sendJson(res, result.status, payload)
    } catch (err) {
      sendJson(res, 503, { error: 'log_proxy_unavailable', message: err.message })
    }
    return
  }

  if (req.method === 'GET' && pathname === '/api/v1/metrics') {
    sendJson(res, 200, { metrics: metricsSnapshot() })
    return
  }

  if (req.method === 'GET' && pathname === '/api/v1/git-sign') {
    const [health, pubkey] = await Promise.all([
      probeHealth(GIT_SIGN_PORT, '/health'),
      probeHealth(GIT_SIGN_PORT, '/pubkey'),
    ])
    sendJson(res, 200, {
      reachable: health.reachable,
      health: health.reachable ? (() => {
        try {
          return JSON.parse(health.body)
        } catch {
          return { ok: health.status === 200 }
        }
      })() : null,
      pubkey: pubkey.reachable ? pubkey.body.trim() : null,
    })
    return
  }

  if (req.method === 'GET' && pathname === '/api/v1/bridge') {
    const status = await probeHealth(BRIDGE_PORT, '/status')
    let body = null
    if (status.reachable) {
      try {
        body = JSON.parse(status.body)
      } catch {}
    }
    sendJson(res, 200, { reachable: status.reachable, status: body })
    return
  }

  if (req.method === 'GET' && pathname === '/api/v1/settings') {
    loadSettings()
    sendJson(res, 200, { settings })
    return
  }

  if (req.method === 'PUT' && pathname === '/api/v1/settings') {
    loadSettings()
    const body = await parseJsonBody(req)
    if (body.settings !== undefined && (typeof body.settings !== 'object' || Array.isArray(body.settings))) {
      return sendJson(res, 400, { error: 'settings must be an object' })
    }
    settings = body.settings !== undefined ? body.settings : {}
    scheduleSave()
    sendJson(res, 200, { settings })
    return
  }

  sendJson(res, 404, { error: 'route_not_found', path: pathname })
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    sendJson(res, 400, { error: 'bad_request', message: err.message })
  })
})

server.on('error', (err) => {
  console.error(`[nexos:web] server error: ${err.message}`)
  process.exit(1)
})

function shutdown() {
  clearTimeout(saveTimer)
  if (loaded && Object.keys(settings).length) persistSettings()
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 1000).unref()
}

server.listen(PORT, HOST, () => {
  console.log(`[nexos:web] portal listening on ${HOST}:${PORT}${TOKEN ? ' (auth enabled)' : ' (no auth)'}`)
  console.log(`[nexos:web] state file: ${STATE_FILE}`)
})

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
