// NexOS bridge API server.
//
// Extracted from the v0 sandbox's code-server v0-bridge extension
// (api-server.js) into a standalone module. It exposes a localhost-only HTTP
// control API that an editor/IDE host (or any process) can call to push state
// into the connected client: toggling read-only, reloading files, renaming
// the workspace, or querying status.
//
// The host plugs in the actual behavior through `handlers`; this module only
// owns the transport and routing.
//
//   const { NexOSBridgeApiServer } = require('./bridge-api')
//   const server = new NexOSBridgeApiServer({
//     getStatus: () => ({ workspace: 'demo', readonly: false }),
//     setReadonly: (readonly, reason) => { /* ... */ },
//     reloadFiles: async (files) => { /* ... */ },
//     setWorkspaceName: (name) => { /* ... */ },
//   }, { port: 9876 })
//   await server.start()

const http = require('http')

class NexOSBridgeApiServer {
  constructor(handlers = {}, options = {}) {
    this.handlers = handlers
    this.port = parseInt(
      options.port || process.env.NEXOS_BRIDGE_PORT || '9876',
      10,
    )
    this.host = options.host || process.env.NEXOS_BRIDGE_HOST || '127.0.0.1'
    this.token = options.token || process.env.NEXOS_BRIDGE_TOKEN || ''
    this.server = null
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) =>
        this.handleRequest(req, res),
      )
      this.server.on('error', reject)
      this.server.listen(this.port, this.host, () => resolve())
    })
  }

  handleRequest(req, res) {
    const sendResponse = (statusCode, data) => {
      res.writeHead(statusCode, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(data))
    }

    // Security: loopback requests are trusted; non-loopback requests must
    // present the bearer token when NEXOS_BRIDGE_TOKEN is configured.
    const remoteAddress = req.socket?.remoteAddress || ''
    const isLocalhost =
      remoteAddress === '127.0.0.1' ||
      remoteAddress === '::1' ||
      remoteAddress === '::ffff:127.0.0.1'
    if (!isLocalhost && this.token) {
      const header = req.headers['authorization'] || ''
      const match = /^Bearer\s+(.+)$/i.exec(header)
      if (!(match && match[1] === this.token)) {
        sendResponse(401, { error: 'Unauthorized' })
        return
      }
    }

    if (req.method === 'GET' && req.url === '/status') {
      const status = this.handlers.getStatus ? this.handlers.getStatus() : {}
      sendResponse(200, { success: true, ...status })
      return
    }

    if (req.method !== 'POST') {
      sendResponse(405, { error: 'Method not allowed' })
      return
    }

    const chunks = []
    let errorOccurred = false
    req.setEncoding('utf8')
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('error', (err) => {
      errorOccurred = true
      if (!res.headersSent) {
        sendResponse(500, { error: 'Request error' })
      }
    })
    req.on('end', async () => {
      if (errorOccurred) return
      let body
      try {
        body = JSON.parse(chunks.join('') || '{}')
      } catch {
        sendResponse(400, { error: 'Invalid JSON' })
        return
      }
      try {
        const path = req.url || '/'
        switch (path) {
          case '/set-readonly': {
            const readonly = body.readonly
            const reason = body.reason
            if (typeof readonly !== 'boolean') {
              sendResponse(400, { error: 'readonly must be a boolean' })
              return
            }
            if (this.handlers.setReadonly) {
              this.handlers.setReadonly(
                readonly,
                typeof reason === 'string' ? reason : undefined,
              )
            }
            sendResponse(200, { success: true })
            break
          }
          case '/reload-files': {
            const files = body.files
            if (!Array.isArray(files) || !files.every((f) => typeof f === 'string')) {
              sendResponse(400, { error: 'files must be an array of strings' })
              return
            }
            if (this.handlers.reloadFiles) {
              await this.handlers.reloadFiles(files)
            }
            sendResponse(200, { success: true })
            break
          }
          case '/set-workspace-name': {
            const name = body.name
            if (typeof name !== 'string') {
              sendResponse(400, { error: 'name must be a string' })
              return
            }
            if (this.handlers.setWorkspaceName) {
              this.handlers.setWorkspaceName(name)
            }
            sendResponse(200, { success: true })
            break
          }
          default:
            sendResponse(404, { error: `Unknown endpoint: ${path}` })
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        sendResponse(500, { error: message })
      }
    })
  }

  dispose() {
    if (this.server) {
      this.server.close()
      this.server = null
    }
  }
}

module.exports = { NexOSBridgeApiServer }
