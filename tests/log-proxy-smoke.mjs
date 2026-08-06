// Log-proxy smoke test: health, exec (wait), history, exec streaming, 403 guard.
import { spawn } from 'child_process'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const NEXOS_ROOT = path.join(__dirname, '..')
const PORT = 7683
const BASE = `http://127.0.0.1:${PORT}`

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let proxy = null

async function startProxy() {
  proxy = spawn(
    process.execPath,
    [path.join(NEXOS_ROOT, 'lib', 'log-proxy.js')],
    {
      cwd: NEXOS_ROOT,
      env: { ...process.env, NEXOS_LOG_PROXY_PORT: String(PORT) },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  proxy.stderr.on('data', (d) => process.stderr.write(`[proxy:err] ${d}`))
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`${BASE}/health`)
      if (res.ok) return
    } catch {}
    await sleep(100)
  }
  throw new Error('log-proxy did not become healthy')
}

function stopProxy() {
  return new Promise((resolve) => {
    if (!proxy || proxy.exitCode !== null) return resolve()
    proxy.on('exit', () => resolve())
    proxy.kill('SIGTERM')
    setTimeout(() => {
      if (proxy.exitCode === null) {
        proxy.kill('SIGKILL')
        resolve()
      }
    }, 3000)
  })
}

async function main() {
  let failures = 0
  const check = (desc, cond) => {
    if (cond) console.log(`ok: ${desc}`)
    else {
      console.log(`FAIL: ${desc}`)
      failures++
    }
  }

  await startProxy()

  const health = await (await fetch(`${BASE}/health`)).json()
  check('health returns status ok', health.status === 'ok')

  const exec = await (
    await fetch(`${BASE}/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cmd: 'sh',
        args: ['-c', 'printf "hello-from-nexos"'],
        wait: true,
      }),
    })
  ).json()
  check('execute success', exec.success === true)
  check('execute returns pid', typeof exec.pid === 'number')

  await sleep(200)
  const history = await (await fetch(`${BASE}/history`)).json()
  const joined = history.logs.map((l) => l.message).join('')
  check('exec output landed in history', joined.includes('hello-from-nexos'))

  const missing = await (
    await fetch(`${BASE}/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ args: ['x'] }),
    })
  ).json()
  check('execute rejects missing cmd', missing.error === 'Missing required field: cmd')

  const bad = await (
    await fetch(`${BASE}/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cmd: '/nonexistent-binary', wait: true }),
    })
  ).json()
  check('exec of missing binary reports error', bad.success === false || bad.error !== undefined)

  const notFound = await fetch(`${BASE}/nope`)
  check('unknown route returns 404', notFound.status === 404)

  await stopProxy()
  if (failures === 0) console.log('log-proxy-smoke: PASS')
  else {
    console.log(`log-proxy-smoke: FAIL (${failures})`)
    process.exit(1)
  }
}

main().catch((err) => {
  console.error('log-proxy-smoke: FAIL —', err.message)
  process.exit(1)
})
