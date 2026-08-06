// Loads a NexOS bridge extension file with a stubbed `vscode` module and
// verifies the bridge API serves live editor state. Used by vsix-smoke.sh to
// prove a packaged VSIX works end-to-end, and usable on the source tree too.
import Module from 'module'
import path from 'path'

const [extPath, portArg] = process.argv.slice(2)
if (!extPath) {
  console.error('usage: node vsix-load.mjs <extension.js> <port>')
  process.exit(1)
}
const PORT = parseInt(portArg || '9971', 10)
process.env.NEXOS_BRIDGE_PORT = String(PORT)

const recorded = {
  configUpdates: [],
  commands: [],
  messages: [],
}

const statusItem = { text: '', show() {}, dispose() {} }

const fakeVscode = {
  StatusBarAlignment: { Right: 1 },
  ConfigurationTarget: { Workspace: 2 },
  workspace: {
    workspaceFolders: [{ name: 'pkgws' }],
    getConfiguration: (section) => ({
      get: (key) =>
        key === 'readonlyInclude' ? recorded.configUpdates.slice(-1)[0]?.[1] ?? {} : undefined,
      update: (key, value) => {
        recorded.configUpdates.push([section + '.' + key, value])
        return Promise.resolve()
      },
    }),
  },
  window: {
    visibleTextEditors: [],
    createStatusBarItem: () => statusItem,
    showInformationMessage: (msg) => {
      recorded.messages.push(msg)
      return Promise.resolve()
    },
  },
  commands: {
    executeCommand: async (cmd, ...args) => {
      recorded.commands.push([cmd, args])
      return undefined
    },
  },
}

const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return fakeVscode
  return origLoad.apply(this, arguments)
}

const ext = await import(`file://${path.resolve(extPath)}`)
const context = { subscriptions: [] }
await ext.activate(context)

let failures = 0
const check = (desc, cond) => {
  if (cond) console.log(`ok: ${desc}`)
  else {
    console.log(`FAIL: ${desc}`)
    failures++
  }
}

const BASE = `http://127.0.0.1:${PORT}`
const post = (route, body) =>
  fetch(`${BASE}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

let up = false
for (let i = 0; i < 50; i++) {
  try {
    if ((await fetch(`${BASE}/status`)).ok) {
      up = true
      break
    }
  } catch {}
  await new Promise((r) => setTimeout(r, 100))
}
check('extension API server is up', up)

const status = await (await fetch(`${BASE}/status`)).json()
check('GET /status reports live workspace', status.workspace === 'pkgws')
check('GET /status reports readonly=false', status.readonly === false)

const ro = await post('/set-readonly', { readonly: true })
check('POST /set-readonly accepted', ro.status === 200)
check('read-only config written', recorded.configUpdates.some(
  ([k, v]) => k === 'files.readonlyInclude' && v['**/*'] === true,
))

for (const sub of context.subscriptions) sub.dispose()

if (failures === 0) console.log('vsix-load: PASS')
else {
  console.log(`vsix-load: FAIL (${failures})`)
  process.exit(1)
}
