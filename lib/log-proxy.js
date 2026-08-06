// NexOS log proxy — WebSocket log streaming + local exec control plane.
//
// Migrated from the v0 sandbox's v0-log-proxy.js. Behavioral contract is
// preserved: localhost-only HTTP API, file-backed (detached) child exec,
// single-ticker tail streaming, batched WS broadcast, 500-event ring history,
// adminOnly filtering. v0-specific constants are now NEXOS_* configurable.
//
// Run under lib/supervisor.sh; NODE_PATH should include a tree containing
// the `ws` dependency (npm install in the NexOS root provides it).

const http = require('http')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')
const { WebSocketServer } = require('ws')

const LOG_PROXY_PORT = parseInt(process.env.NEXOS_LOG_PROXY_PORT || '7682', 10)
const EXEC_LOG_DIR =
  process.env.NEXOS_EXEC_LOG_DIR || path.join(os.tmpdir(), 'nexos-exec-logs')

// =============================================================================
// History Management
// =============================================================================

const MAX_LOG_HISTORY = 500
const logHistory = []

function addToLogHistory(event) {
  logHistory.push(event)
  if (logHistory.length > MAX_LOG_HISTORY) {
    logHistory.shift()
  }
}

function getFullHistory() {
  return [...logHistory]
}

function clearHistory() {
  logHistory.length = 0
  pendingLogs = []
  if (flushTimeout) {
    clearTimeout(flushTimeout)
    flushTimeout = null
  }
}

// =============================================================================
// Broadcasting
// =============================================================================

// Message batching state
let pendingLogs = []
let flushTimeout = null
const BATCH_INTERVAL_MS = 50

/**
 * Broadcast an event to connected clients.
 * If the event has adminOnly: true, it will only be sent to admin clients.
 */
function broadcast(event, addToHistory = true) {
  const message = JSON.stringify(event)
  const isAdminOnly = event.adminOnly === true

  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) {
      // Skip non-admin clients for admin-only events
      if (isAdminOnly && !client.isAdmin) {
        continue
      }
      client.send(message)
    }
  }

  if (addToHistory && (event.type === 'log' || event.type === 'logs-batch')) {
    const logs = event.type === 'logs-batch' ? event.logs : [event]
    for (const log of logs) {
      addToLogHistory(log)
    }
  }
}

/**
 * Queue a log message for batched broadcasting.
 */
function queueLog(stream, message, options = {}) {
  pendingLogs.push({
    type: 'log',
    stream,
    message,
    timestamp: Date.now(),
    ...(options.adminOnly && { adminOnly: true }),
    ...(options.blockId && { blockId: options.blockId }),
  })

  if (!flushTimeout) {
    flushTimeout = setTimeout(flushLogs, BATCH_INTERVAL_MS)
  }
}

function flushLogs() {
  flushTimeout = null
  if (pendingLogs.length === 0) return

  // Group logs by adminOnly flag
  const regularLogs = []
  const adminOnlyLogs = []

  for (const log of pendingLogs) {
    ;(log.adminOnly ? adminOnlyLogs : regularLogs).push(log)
  }

  // Helper to send a batch of logs
  const sendBatch = (logs, adminOnly = false) => {
    if (logs.length === 0) return
    if (logs.length === 1) {
      broadcast(logs[0])
    } else {
      broadcast({
        type: 'logs-batch',
        logs,
        timestamp: Date.now(),
        ...(adminOnly && { adminOnly: true }),
      })
    }
  }

  sendBatch(regularLogs)
  sendBatch(adminOnlyLogs, true)

  pendingLogs = []
}

function broadcastLog(stream, message, options = {}) {
  queueLog(stream, message, options)
}

function broadcastError(code, message, stack) {
  flushLogs() // Flush pending logs first so error appears in order
  broadcast({
    type: 'error',
    code,
    message,
    timestamp: Date.now(),
    ...(stack && { stack }),
  })
}

// =============================================================================
// Log Filtering
// =============================================================================

const INTERNAL_ROUTE_PATTERNS = ['/code-server?']

function isInternalLog(message) {
  return INTERNAL_ROUTE_PATTERNS.some((pattern) => message.includes(pattern))
}

// =============================================================================
// Process Execution
// =============================================================================

// Children write their output to files that we tail, NOT to pipes back into
// this process. A pipe ties the child's lifetime to ours: when the proxy is
// stopped or restarted the read end closes, and the child dies of
// SIGPIPE/EPIPE on its next write. These are user processes (dev servers)
// that must outlive proxy restarts — detached:true already gives them their
// own process group; file-backed stdio removes the last lifetime coupling.
const EXEC_LOG_MAX_BYTES = 10 * 1024 * 1024
const EXEC_TAIL_INTERVAL_MS = 100
let execSeq = 0

// On startup, remove exec log files left behind by previous proxy runs. Our own
// tails truncate (10MB cap) and unlink the files we create, but children spawned
// by a prior proxy survive its restart (detached:true), so their .out/.err files
// are orphaned: the old proxy's tail intervals died with it, and this fresh proxy
// has no tail re-adopting them. Without this cleanup, orphaned exec logs
// accumulate — and, for a still-running chatty dev server, grow unbounded —
// across resume/recovery restarts and can fill the disk. We only touch
// files from OTHER pids so we never race with our own live tails.
function cleanupStaleExecLogs() {
  let entries
  try {
    entries = fs.readdirSync(EXEC_LOG_DIR)
  } catch {
    return
  }
  const ownPrefix = `exec-${process.pid}-`
  for (const name of entries) {
    if (!/^exec-\d+-\d+\.(out|err)$/.test(name)) continue
    if (name.startsWith(ownPrefix)) continue
    try {
      fs.unlinkSync(path.join(EXEC_LOG_DIR, name))
    } catch {}
  }
}

// All tails share one ticker: N children would otherwise mean 2N timers
// waking the event loop every 100ms each, even for silent children. Each
// tail keeps its fd open for the file's lifetime — reopening per tick costs
// stat+open+close syscalls forever in the busiest process.
const EXEC_TAIL_MAX_READ_BYTES = 64 * 1024
const activeTails = new Set()
let tailTimer = null

function pumpTails() {
  for (const tail of activeTails) tail.read()
}

function tailFile(file, onChunk) {
  let offset = 0
  let fd = null
  try {
    // r+ so the 10MB cap can ftruncate through the same fd.
    fd = fs.openSync(file, 'r+')
  } catch {}
  const tail = {
    read: () => {
      if (fd === null) return
      let size
      try {
        size = fs.fstatSync(fd).size
      } catch {
        return
      }
      if (size > EXEC_LOG_MAX_BYTES) {
        try {
          fs.ftruncateSync(fd, 0)
        } catch {}
        offset = 0
        return
      }
      if (size < offset) offset = 0
      if (size === offset) return
      // Cap each read: a chatty burst between ticks must not balloon into a
      // one-shot multi-MB buffer + WS message; the next tick drains the rest.
      const buf = Buffer.allocUnsafe(
        Math.min(size - offset, EXEC_TAIL_MAX_READ_BYTES),
      )
      let n
      try {
        n = fs.readSync(fd, buf, 0, buf.length, offset)
      } catch {
        return
      }
      offset += n
      if (n > 0) onChunk(buf.toString('utf8', 0, n))
    },
    stop: () => {
      if (!activeTails.has(tail)) return
      activeTails.delete(tail)
      if (activeTails.size === 0 && tailTimer !== null) {
        clearInterval(tailTimer)
        tailTimer = null
      }
      // Final drain (in capped chunks) of anything the last tick missed.
      let before = -1
      while (before !== offset) {
        before = offset
        tail.read()
      }
      if (fd !== null) {
        try {
          fs.closeSync(fd)
        } catch {}
        fd = null
      }
      try {
        fs.unlinkSync(file)
      } catch {}
    },
  }
  activeTails.add(tail)
  if (tailTimer === null) {
    tailTimer = setInterval(pumpTails, EXEC_TAIL_INTERVAL_MS)
  }
  return tail
}

/**
 * Execute a command, broadcast its stdout/stderr to WebSocket clients,
 * and return the PID. If `wait` is true, block until the process exits
 * and include the exit code in the result.
 */
function executeCommand(cmd, args = [], cwd, env = {}, wait = false, blockId) {
  return new Promise((resolve) => {
    const result = {
      success: false,
      pid: null,
      error: null,
    }

    const usePty = env.__NEXOS_USE_PTY === 'true'
    const childEnv = { ...process.env, ...env }
    delete childEnv.__NEXOS_USE_PTY

    const shellEscape = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`
    const [actualCmd, actualArgs] = usePty
      ? [
          '/usr/bin/script',
          ['-qefc', [cmd, ...args].map(shellEscape).join(' '), '/dev/null'],
        ]
      : [cmd, args]

    console.log(
      `[nexos:log-proxy] Executing: ${actualCmd} ${actualArgs.join(' ')}${cwd ? ` in ${cwd}` : ''}${wait ? ' (waiting)' : ''}${usePty ? ' [pty]' : ''}`,
    )

    try {
      const base = path.join(EXEC_LOG_DIR, `exec-${process.pid}-${++execSeq}`)
      const outPath = `${base}.out`
      const errPath = `${base}.err`
      const outFd = fs.openSync(outPath, 'a')
      const errFd = fs.openSync(errPath, 'a')

      let child
      try {
        child = spawn(actualCmd, actualArgs, {
          cwd: cwd || undefined,
          stdio: ['ignore', outFd, errFd],
          env: childEnv,
          // detached gives the child its own process group. The log proxy runs
          // under nexos-supervise, whose stop/restart kills the supervisor's
          // whole process group — user processes spawned here (dev servers,
          // terminals) must not be collateral of a log-proxy restart.
          detached: true,
        })
      } finally {
        // The child holds its own duplicates after spawn.
        fs.closeSync(outFd)
        fs.closeSync(errFd)
      }

      const outTail = tailFile(outPath, (message) => {
        process.stdout.write(`[exec:${child.pid}] ${message}`)
        if (!isInternalLog(message)) {
          broadcastLog('stdout', message, { blockId })
        }
      })

      const errTail = tailFile(errPath, (message) => {
        process.stderr.write(`[exec:${child.pid}] ${message}`)
        if (!isInternalLog(message)) {
          broadcastLog('stderr', message, { blockId })
        }
      })

      child.on('error', (error) => {
        console.error(`[nexos:log-proxy] Process error (PID ${child.pid}):`, error)
        broadcastError('PROCESS_ERROR', error.message, error.stack)
        outTail.stop()
        errTail.stop()
        if (wait) {
          // spawn can fail before the child exists (e.g. ENOENT); on 'error'
          // child.pid is undefined, so a `=== null` guard would leave the
          // wait promise unresolved forever and hang the caller.
          result.success = false
          result.pid = null
          result.error = error.message
          resolve(result)
        }
      })

      child.on('exit', (code, signal) => {
        outTail.stop()
        errTail.stop()
        console.log(
          `[nexos:log-proxy] Process exited (PID ${child.pid}): code=${code}, signal=${signal}`,
        )

        if (wait) {
          resolve({ success: true, pid: child.pid, exitCode: code })
        }
      })

      result.success = true
      result.pid = child.pid
      console.log(`[nexos:log-proxy] Process started with PID ${child.pid}`)

      if (!wait) {
        resolve(result)
      }
    } catch (error) {
      console.error('[nexos:log-proxy] Failed to execute command:', error)
      broadcastError('EXEC_ERROR', error.message, error.stack)
      result.error = error.message
      resolve(result)
    }
  })
}

// =============================================================================
// HTTP API Routes
// =============================================================================

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk.toString()))
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {})
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

function jsonResponse(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(data))
}

// Route handlers grouped by HTTP method
const routes = {
  GET: {
    '/health': (req, res) => {
      jsonResponse(res, 200, {
        status: 'ok',
        clients: wss.clients.size,
      })
    },

    '/history': (req, res) => {
      // Parse query params for filtering
      const parsedUrl = new URL(req.url || '', 'http://localhost')
      const since = parseInt(parsedUrl.searchParams.get('since') || '0', 10)
      const isAdmin = parsedUrl.searchParams.get('isAdmin') === 'true'

      let history = getFullHistory()

      // Filter by timestamp if 'since' provided
      if (since > 0) {
        history = history.filter((event) => event.timestamp > since)
      }

      // Filter out admin-only events for non-admin requests
      if (!isAdmin) {
        history = history.filter((event) => !event.adminOnly)
      }

      jsonResponse(res, 200, {
        logs: history,
        timestamp: Date.now(),
      })
    },
  },

  POST: {
    '/execute': async (req, res) => {
      const body = await parseJsonBody(req)
      if (!body.cmd) {
        return jsonResponse(res, 400, {
          error: 'Missing required field: cmd',
        })
      }
      const result = await executeCommand(
        body.cmd,
        body.args,
        body.cwd,
        body.env,
        body.wait === true,
        body.blockId,
      )
      jsonResponse(res, result.success ? 200 : 500, result)
    },

    '/clear': (req, res) => {
      clearHistory()
      jsonResponse(res, 200, { success: true, cleared: true })
    },

    '/log': async (req, res) => {
      const body = await parseJsonBody(req)
      if (!body.message) {
        return jsonResponse(res, 400, {
          error: 'Missing required field: message',
        })
      }
      broadcastLog(body.stream || 'stdout', body.message, {
        adminOnly: body.adminOnly === true,
        blockId: body.blockId,
      })
      jsonResponse(res, 200, { success: true, broadcast: true })
    },
  },
}

// HTTP server
const server = http.createServer(async (req, res) => {
  // Security: Only allow localhost connections to the control API unless
  // NEXOS_ALLOW_REMOTE=true explicitly opts in to remote clients (e.g. for
  // Docker port publishing).
  const remoteAddress = req.socket?.remoteAddress || ''
  const isLocalhost =
    remoteAddress === '127.0.0.1' ||
    remoteAddress === '::1' ||
    remoteAddress === '::ffff:127.0.0.1'
  const allowRemote = (process.env.NEXOS_ALLOW_REMOTE || '') === 'true'

  if (!isLocalhost && !allowRemote) {
    return jsonResponse(res, 403, { error: 'Forbidden' })
  }

  // Route matching
  const parsedUrl = new URL(req.url || '', 'http://localhost')
  const handler = routes[req.method]?.[parsedUrl.pathname]

  if (handler) {
    try {
      await handler(req, res)
    } catch (error) {
      jsonResponse(res, 500, { error: error.message })
    }
  } else {
    jsonResponse(res, 404, { error: 'Not found' })
  }
})

// =============================================================================
// WebSocket Server
// =============================================================================

const wss = new WebSocketServer({ server })

wss.on('connection', (ws, req) => {
  // Parse query params using URL class (replaces deprecated url.parse)
  const parsedUrl = new URL(req.url || '', 'http://localhost')
  const isAdmin = parsedUrl.searchParams.get('isAdmin') === 'true'

  // Store admin flag directly on the client object
  ws.isAdmin = isAdmin

  console.log(
    `[nexos:log-proxy] ${isAdmin ? 'Admin client' : 'Client'} connected (${wss.clients.size} total)`,
  )

  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data.toString())
      handleWsCommand(ws, message)
    } catch (error) {
      console.error('[nexos:log-proxy] Invalid message:', error)
    }
  })

  ws.on('close', () => {
    console.log(
      `[nexos:log-proxy] Client disconnected (${wss.clients.size} remaining)`,
    )
  })

  ws.on('error', (err) => {
    if (err.code !== 'ECONNRESET') {
      console.error('[nexos:log-proxy] Client error:', err)
    }
  })
})

function handleWsCommand(ws, command) {
  switch (command.type) {
    case 'get-history': {
      const history = getFullHistory()
      // Filter out admin-only events for non-admin clients
      const filteredHistory = ws.isAdmin
        ? history
        : history.filter((event) => !event.adminOnly)

      ws.send(
        JSON.stringify({
          type: 'history',
          events: filteredHistory,
          timestamp: Date.now(),
        }),
      )
      break
    }

    default:
      console.warn('[nexos:log-proxy] Unknown command:', command.type)
  }
}

// =============================================================================
// Server Lifecycle
// =============================================================================

server.on('error', (err) => {
  console.error('[nexos:log-proxy] Server error:', err)
  process.exit(1)
})

function shutdown(signal) {
  console.log(`[nexos:log-proxy] Received ${signal}, shutting down...`)

  flushLogs()

  for (const client of wss.clients) {
    client.close()
  }

  wss.close()
  server.close(() => process.exit(0))
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

fs.mkdirSync(EXEC_LOG_DIR, { recursive: true })
cleanupStaleExecLogs()

server.listen(LOG_PROXY_PORT, '0.0.0.0', () => {
  console.log(
    `[nexos:log-proxy] WebSocket log proxy listening on port ${LOG_PROXY_PORT}`,
  )
})
