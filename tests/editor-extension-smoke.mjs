// Editor-extension smoke test: loads the extension with a stubbed `vscode`
// module, activates it, and exercises the bridge API against the live
// (stubbed) editor handlers.
import Module from 'module'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const EXT = path.join(__dirname, '..', 'bridge', 'editor-extension', 'extension.js')

const PORT = 9965
process.env.NEXOS_BRIDGE_PORT = String(PORT)

const recorded = {
  configUpdates: [],
  commands: [],
  messages: [],
}

const statusItem = {
  text: '',
  show() {},
  dispose() {},
}

const fakeVscode = {
  StatusBarAlignment: { Right: 1 },
  ConfigurationTarget: { Workspace: 2 },
  workspace: {
    workspaceFolders: [{ name: 'testws' }],
    getConfiguration: (section) => ({
      get: (key) =>
        key === 'readonlyInclude'
          ? recorded.configUpdates.slice(-1)[0]?.[1] ?? {}
          : undefined,
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

const ext = await import(`file://${EXT}`)
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

// wait for the API server to come up
let up = false
for (let i = 0; i < 50; i++) {
  try {
    const res = await fetch(`${BASE}/status`)
    if (res.ok) {
      up = true
      break
    }
  } catch {}
  await new Promise((r) => setTimeout(r, 100))
}
check('extension API server is up', up)

const status1 = await (await fetch(`${BASE}/status`)).json()
check('GET /status reports live workspace', status1.workspace === 'testws')
check('GET /status reports readonly=false', status1.readonly === false)

const ro = await post('/set-readonly', { readonly: true, reason: 'review' })
check('POST /set-readonly accepted', ro.status === 200)
check('read-only config written to workspace', recorded.configUpdates.some(
  ([k, v]) => k === 'files.readonlyInclude' && v['**/*'] === true,
))

const status2 = await (await fetch(`${BASE}/status`)).json()
check('readonly now true via live config', status2.readonly === true)

const rw = await post('/set-readonly', { readonly: false })
check('read-only cleared', rw.status === 200)
check('read-only cleared in config', recorded.configUpdates.some(
  ([k, v]) => k === 'files.readonlyInclude' && Object.keys(v).length === 0,
))

const name = await post('/set-workspace-name', { name: 'renamed' })
check('POST /set-workspace-name accepted', name.status === 200)
check('workspace label updated in status bar', statusItem.text.endsWith('renamed'))

const reload = await post('/reload-files', { files: ['a.ts'] })
check('POST /reload-files accepted', reload.status === 200)
check('window reload requested when nothing matched', recorded.commands.some(
  ([cmd]) => cmd === 'workbench.action.reloadWindow',
))

for (const sub of context.subscriptions) sub.dispose()

if (failures === 0) {
  console.log('editor-extension-smoke: PASS')
} else {
  console.log(`editor-extension-smoke: FAIL (${failures})`)
  process.exit(1)
}
