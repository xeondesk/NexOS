// NexOS bridge — standalone bootstrap.
//
// Runs the bridge API as an ordinary supervised service. Since there is no
// code-server extension host to inject editor behavior, this bootstrap wires
// the transport to filesystem-backed default handlers in the NexOS state dir:
//
//   GET /status              -> { workspace, readonly } read from state
//   POST /set-readonly       -> persists state/readonly
//   POST /set-workspace-name -> persists state/workspace-name
//   POST /reload-files       -> appends to state/reload-requests.log
//
// The host (or any process) can read that state back, or a future editor
// extension can replace the handlers via the NexOSBridgeApiServer class.

const path = require('path')
const fs = require('fs')
const { NexOSBridgeApiServer } = require('./bridge-api')

// Config arrives via NEXOS_* env vars (matching nexos.conf defaults); the
// .conf file itself is shell syntax and never require()d from node code.
const root = process.env.NEXOS_ROOT || path.join(__dirname, '..')
const port = parseInt(process.env.NEXOS_BRIDGE_PORT || '9876', 10)
const host = process.env.NEXOS_BRIDGE_HOST || '127.0.0.1'
const workspace = process.env.NEXOS_WORKSPACE || path.join(root, 'workspace')
const stateDir = process.env.NEXOS_RUN_DIR || path.join(root, 'state/run')
fs.mkdirSync(stateDir, { recursive: true })

const stateFile = (name) => path.join(stateDir, name)

const readState = (name, fallback) => {
  try {
    const raw = fs.readFileSync(stateFile(name), 'utf8').trim()
    return raw.length > 0 ? raw : fallback
  } catch {
    return fallback
  }
}

const server = new NexOSBridgeApiServer(
  {
    getStatus: () => ({
      workspace: readState('workspace-name', path.basename(workspace)),
      readonly: readState('readonly', 'false') === 'true',
    }),
    setReadonly: (readonly, reason) => {
      fs.writeFileSync(stateFile('readonly'), String(readonly))
      if (reason) fs.appendFileSync(stateFile('readonly-reasons.log'), `${new Date().toISOString()} ${reason}\n`)
    },
    reloadFiles: (files) => {
      fs.appendFileSync(
        stateFile('reload-requests.log'),
        `${new Date().toISOString()} ${files.join(' ')}\n`,
      )
    },
    setWorkspaceName: (name) => {
      fs.writeFileSync(stateFile('workspace-name'), name)
    },
  },
  { port, host },
)

server
  .start()
  .then(() => {
    console.log(`[nexos:bridge] listening on ${host}:${port}`)
  })
  .catch((err) => {
    console.error(`[nexos:bridge] failed to start: ${err.message}`)
    process.exit(1)
  })

process.on('SIGTERM', () => {
  server.dispose()
  process.exit(0)
})
process.on('SIGINT', () => {
  server.dispose()
  process.exit(0)
})
