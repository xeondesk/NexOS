// Log-proxy smoke test: health, exec (wait), history, exec streaming, 403 guard.
import { spawn } from 'child_process'
import os from 'os'
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

  // --- adminOnly filtering (loopback is admin by default) ---
  const adminMark = `admin-marker-${Date.now()}`
  await fetch(`${BASE}/log`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: adminMark, adminOnly: true }),
  })
  await sleep(150) // /log batches for 50ms before flushing to history
  const adminHistory = await (
    await fetch(`${BASE}/history?isAdmin=true`)
  ).json()
  check('loopback admin sees admin-only log lines', adminHistory.logs.some(
    (l) => l.message === adminMark,
  ))
  const plainHistory = await (await fetch(`${BASE}/history`)).json()
  check('non-admin history hides admin-only log lines', !plainHistory.logs.some(
    (l) => l.message === adminMark,
  ))

  // --- remote reachability (NEXOS_ALLOW_REMOTE) ---
  const remoteIP = Object.values(os.networkInterfaces())
    .flat()
    .find((i) => i && i.family === 'IPv4' && !i.internal)?.address

  if (remoteIP) {
    const forbidden = await fetch(`http://${remoteIP}:${PORT}/health`)
    check('non-loopback blocked with 403 by default', forbidden.status === 403)

    // Remote, no token configured: served, but forced non-admin.
    const PORT2 = PORT + 1
    const proxy2 = spawn(
      process.execPath,
      [path.join(NEXOS_ROOT, 'lib', 'log-proxy.js')],
      {
        cwd: NEXOS_ROOT,
        env: {
          ...process.env,
          NEXOS_LOG_PROXY_PORT: String(PORT2),
          NEXOS_ALLOW_REMOTE: 'true',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    proxy2.stderr.on('data', (d) => process.stderr.write(`[proxy2:err] ${d}`))
    let remoteOk = false
    for (let i = 0; i < 50; i++) {
      try {
        const res = await fetch(`http://${remoteIP}:${PORT2}/health`)
        if (res.ok) {
          remoteOk = true
          break
        }
      } catch {}
      await sleep(100)
    }
    check('NEXOS_ALLOW_REMOTE=true serves non-loopback', remoteOk)
    if (remoteOk) {
      await fetch(`http://127.0.0.1:${PORT2}/log`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: adminMark, adminOnly: true }),
      })
      await sleep(150)
      const remoteHistory = await (
        await fetch(`http://${remoteIP}:${PORT2}/history?isAdmin=true`)
      ).json()
      check('remote without token is forced non-admin', !remoteHistory.logs.some(
        (l) => l.message === adminMark,
      ))
    }
    proxy2.kill('SIGTERM')
    const killTimer = setTimeout(() => proxy2.kill('SIGKILL'), 3000)
    killTimer.unref()
    await new Promise((r) => proxy2.once('exit', r))

    // Remote with a configured token: 401 without it, admin with it.
    const PORT3 = PORT + 2
    const TOKEN = 'smoke-secret'
    const proxy3 = spawn(
      process.execPath,
      [path.join(NEXOS_ROOT, 'lib', 'log-proxy.js')],
      {
        cwd: NEXOS_ROOT,
        env: {
          ...process.env,
          NEXOS_LOG_PROXY_PORT: String(PORT3),
          NEXOS_ALLOW_REMOTE: 'true',
          NEXOS_LOG_PROXY_TOKEN: TOKEN,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    proxy3.stderr.on('data', (d) => process.stderr.write(`[proxy3:err] ${d}`))
    for (let i = 0; i < 50; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${PORT3}/health`)
        if (res.ok) break
      } catch {}
      await sleep(100)
    }
    const noToken = await fetch(`http://${remoteIP}:${PORT3}/health`)
    check('remote without token gets 401', noToken.status === 401)
    const wrongToken = await fetch(`http://${remoteIP}:${PORT3}/health`, {
      headers: { Authorization: 'Bearer wrong' },
    })
    check('remote with wrong token gets 401', wrongToken.status === 401)
    const rightToken = await fetch(`http://${remoteIP}:${PORT3}/health`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    })
    check('remote with valid token is served', rightToken.status === 200)
    const loopbackToken = await fetch(`http://127.0.0.1:${PORT3}/health`)
    check('loopback needs no token even when configured', loopbackToken.status === 200)
    // loopback can still post admin lines; remote with token can read them
    await fetch(`http://127.0.0.1:${PORT3}/log`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: adminMark, adminOnly: true }),
    })
    await sleep(150)
    const authedRemoteHistory = await (
      await fetch(`http://${remoteIP}:${PORT3}/history?isAdmin=true`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      })
    ).json()
    check('token-authed remote sees admin-only log lines', authedRemoteHistory.logs.some(
      (l) => l.message === adminMark,
    ))
    proxy3.kill('SIGTERM')
    const killTimer3 = setTimeout(() => proxy3.kill('SIGKILL'), 3000)
    killTimer3.unref()
    await new Promise((r) => proxy3.once('exit', r))
  } else {
    console.log('skipped: no non-loopback interface for remote-reachability check')
  }

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
