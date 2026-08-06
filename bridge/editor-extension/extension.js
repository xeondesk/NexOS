// NexOS Bridge — code-server editor extension.
//
// The v0 sandbox ran its bridge inside the code-server extension host so the
// control plane could mutate the open editor directly. This extension
// reproduces that behavior for self-hosted NexOS: it starts the same
// NexOSBridgeApiServer transport and plugs in live handlers.
//
// Install: add this directory to code-server's extensions path, e.g.
//
//   code-server --extensions-dir /opt/nexos/bridge/editor-extension \
//               --bind-addr 0.0.0.0:4444 ...
//
// The extension reads NEXOS_BRIDGE_PORT / NEXOS_BRIDGE_HOST /
// NEXOS_ALLOW_REMOTE from the code-server process environment.
//
//   GET /status              -> { workspace, readonly } from the live editor
//   POST /set-readonly       -> toggles files.readonlyInclude in the workspace
//   POST /reload-files       -> reverts matching open editors (or reloads the
//                               window if nothing matched)
//   POST /set-workspace-name -> updates the status-bar workspace label
//
// `require('vscode')` is deliberately only evaluated inside activate() so the
// module stays loadable under test with a stubbed vscode.
//
// The bridge transport is resolved from `./bridge-api` when present (the copy
// vendored by `build-vsix.sh`, which also strips the fallback so the packaged
// VSIX is self-contained), falling back to `../bridge-api` for source-tree
// installs. The extension therefore works both unpacked in the repo and inside
// a packaged VSIX.

let NexOSBridgeApiServer
try {
  ;({ NexOSBridgeApiServer } = require('./bridge-api'))
} catch {
  ;({ NexOSBridgeApiServer } = require('../bridge-api'))
}

async function activate(context) {
  const vscode = require('vscode')

  const port = parseInt(process.env.NEXOS_BRIDGE_PORT || '9876', 10)
  const allowRemote = (process.env.NEXOS_ALLOW_REMOTE || '') === 'true'
  const host = process.env.NEXOS_BRIDGE_HOST || (allowRemote ? '0.0.0.0' : '127.0.0.1')

  const workspaceName = () =>
    (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0]
      ? vscode.workspace.workspaceFolders[0].name
      : 'workspace')

  const statusItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100,
  )
  const refreshLabel = () => {
    statusItem.text = `$(git-branch) ${workspaceName()}${getReadonly() ? ' \u{1F512}' : ''}`
  }

  const getReadonly = () =>
    vscode.workspace.getConfiguration('files').get('readonlyInclude')?.['**/*'] ===
    true

  const setReadonly = async (readonly, reason) => {
    await vscode.workspace
      .getConfiguration('files')
      .update(
        'readonlyInclude',
        readonly ? { '**/*': true } : {},
        vscode.ConfigurationTarget.Workspace,
      )
    refreshLabel()
    if (reason) {
      vscode.window.showInformationMessage(
        `NexOS: ${readonly ? 'read-only' : 'read-write'} (${reason})`,
      )
    }
  }

  const reloadFiles = async (files) => {
    let reloaded = 0
    for (const editor of vscode.window.visibleTextEditors) {
      const p = editor.document.uri.path
      if (files.includes(p) || files.includes(p.replace(/^\//, ''))) {
        await vscode.commands.executeCommand(
          'workbench.action.files.revert',
          editor.document.uri,
        )
        reloaded++
      }
    }
    if (reloaded === 0) {
      await vscode.commands.executeCommand('workbench.action.reloadWindow')
    }
    vscode.window.showInformationMessage(
      `NexOS: reloaded ${reloaded === 0 ? 'window' : `${reloaded} file(s)`}`,
    )
  }

  const setWorkspaceName = (name) => {
    statusItem.text = `$(git-branch) ${name}`
    vscode.window.showInformationMessage(`NexOS: workspace \u2192 ${name}`)
  }

  const server = new NexOSBridgeApiServer(
    {
      getStatus: () => ({ workspace: workspaceName(), readonly: getReadonly() }),
      setReadonly,
      reloadFiles,
      setWorkspaceName,
    },
    { port, host },
  )

  statusItem.show()
  await server.start()
  console.log(`[nexos:bridge] editor extension listening on ${host}:${port}`)

  context.subscriptions.push({
    dispose: () => {
      server.dispose()
      statusItem.dispose()
    },
  })
}

function deactivate() {}

module.exports = { activate, deactivate }
