// NexOS reference git SSH-signing service.
//
// A self-hosted replacement for the legacy v0 git-sign endpoint. Git's SSH
// signatures keep the private key off the host: `git/ssh-sign.sh` (a drop-in
// for `ssh-keygen -Y sign`) forwards the payload to this service, which holds
// the signing key and returns an armored SSH SIGNATURE.
//
// The signed bytes follow the OpenSSH "ssh-sign" format (sshsig.c):
//
//   tosign = "SSHSIG" + string(namespace) + string("") + string(hashalg)
//            + string(H(hashalg, data))
//
// and the returned blob embeds the signer's public key, namespace, hash
// algorithm and signature:
//
//   blob = "SSHSIG" + u32(1) + string(pubkey) + string(namespace)
//          + string("") + string(hashalg) + string(sig)
//
// The namespace and hashalg are serialized as plain RFC 4251 strings (no
// trailing NUL) — this matches what OpenSSH 8.7 (and the OpenSSH versions git
// supports) actually signs and parses. Empirically verified against
// `ssh-keygen -Y verify` (which git uses) on 8.7p1: the cstring form (trailing
// NUL, present only in newer sshsig.c) fails with "Signature verification
// failed: incorrect signature".
//
// `ssh-keygen -Y verify` parses that blob back out, so a signature from this
// service verifies without any client-side key material.
//
// Configuration (NEXOS_* env vars):
//   NEXOS_GIT_SIGN_PORT           listening port (default 9877)
//   NEXOS_GIT_SIGN_HOST           bind host (default 127.0.0.1; 0.0.0.0 when
//                                 NEXOS_GIT_SIGN_ALLOW_REMOTE or
//                                 NEXOS_ALLOW_REMOTE=true)
//   NEXOS_GIT_SIGN_KEY            path to a PKCS#8 ed25519 private key (PEM)
//   NEXOS_GIT_SIGN_KEY_PEM        the key inline (alternative to the path)
//   NEXOS_GIT_SIGN_TOKEN          optional bearer token for non-loopback
//                                 clients (loopback stays trusted)
//   NEXOS_GIT_SIGN_HASHALG        sha256 or sha512 (default sha512)
//   NEXOS_GIT_SIGN_NAMESPACE_HEADER  header carrying the signature namespace
//                                 (default x-v0-git-signing-namespace, the
//                                 header git/ssh-sign.sh already sends)
//
// Endpoints:
//   GET /health    -> { ok: true }
//   GET /pubkey    -> OpenSSH public key line (for allowed-signers setup)
//   POST /sign     -> body = raw data, namespace in the namespace header;
//                     returns the armored SSH SIGNATURE
//
// Generate a keypair with:  node git/sign-keygen.js [out-dir]

const http = require('http')
const fs = require('fs')
const crypto = require('crypto')

const PORT = parseInt(process.env.NEXOS_GIT_SIGN_PORT || '9877', 10)
const allowRemote =
  (process.env.NEXOS_GIT_SIGN_ALLOW_REMOTE || process.env.NEXOS_ALLOW_REMOTE ||
    '') === 'true'
const host = process.env.NEXOS_GIT_SIGN_HOST || (allowRemote ? '0.0.0.0' : '127.0.0.1')
const token = process.env.NEXOS_GIT_SIGN_TOKEN || ''
const namespaceHeader =
  process.env.NEXOS_GIT_SIGN_NAMESPACE_HEADER || 'x-v0-git-signing-namespace'
const hashalg = process.env.NEXOS_GIT_SIGN_HASHALG || 'sha512'
const MAX_BODY_BYTES = 1024 * 1024
const SIGNATURE_TYPE = 'ssh-ed25519'
const HASHALG_ALLOWED = ['sha256', 'sha512']

if (!HASHALG_ALLOWED.includes(hashalg)) {
  console.error(`[nexos:git-sign] unsupported hash algorithm "${hashalg}" (allowed: ${HASHALG_ALLOWED.join(', ')})`)
  process.exit(1)
}

let keyPem = process.env.NEXOS_GIT_SIGN_KEY_PEM || ''
if (!keyPem && process.env.NEXOS_GIT_SIGN_KEY) {
  try {
    keyPem = fs.readFileSync(process.env.NEXOS_GIT_SIGN_KEY, 'utf8')
  } catch (err) {
    console.error(`[nexos:git-sign] cannot read NEXOS_GIT_SIGN_KEY ${process.env.NEXOS_GIT_SIGN_KEY}: ${err.message}`)
    process.exit(1)
  }
}
if (!keyPem) {
  console.error('[nexos:git-sign] no signing key: set NEXOS_GIT_SIGN_KEY or NEXOS_GIT_SIGN_KEY_PEM')
  process.exit(1)
}

let privateKey
try {
  privateKey = crypto.createPrivateKey(keyPem)
} catch (err) {
  console.error(`[nexos:git-sign] invalid signing key: ${err.message}`)
  process.exit(1)
}

// ---- SSH wire encoding helpers (RFC 4251 strings) ----
function u32(value) {
  const buf = Buffer.alloc(4)
  buf.writeUInt32BE(value)
  return buf
}

function sshString(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf)
  return Buffer.concat([u32(b.length), b])
}

// ---- signer public key (OpenSSH wire format + text line) ----
const jwk = crypto.createPublicKey(privateKey).export({ format: 'jwk' })
if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519') {
  console.error('[nexos:git-sign] only ed25519 signing keys are supported')
  process.exit(1)
}
const pubRaw = Buffer.from(jwk.x, 'base64url')
const pubKeyWire = Buffer.concat([
  sshString(Buffer.from(SIGNATURE_TYPE)),
  sshString(pubRaw),
])
const pubKeyLine = `${SIGNATURE_TYPE} ${pubKeyWire.toString('base64')} nexos-git-sign`

function signData(data, namespace) {
  const hash = crypto.createHash(hashalg).update(data).digest()
  const ns = sshString(namespace)
  const alg = sshString(hashalg)
  const tosign = Buffer.concat([
    Buffer.from('SSHSIG'),
    ns,
    sshString(Buffer.alloc(0)),
    alg,
    sshString(hash),
  ])
  const rawSig = crypto.sign(null, tosign, privateKey)
  const sigBlob = Buffer.concat([
    sshString(Buffer.from(SIGNATURE_TYPE)),
    sshString(rawSig),
  ])
  const blob = Buffer.concat([
    Buffer.from('SSHSIG'),
    u32(1),
    sshString(pubKeyWire),
    ns,
    sshString(Buffer.alloc(0)),
    alg,
    sshString(sigBlob),
  ])
  return armor(blob)
}

function armor(blob) {
  const b64 = blob.toString('base64').replace(/(.{70})/g, '$1\n').replace(/\n$/, '')
  return `-----BEGIN SSH SIGNATURE-----\n${b64}\n-----END SSH SIGNATURE-----\n`
}

function isLocalhost(address) {
  return (
    address === '127.0.0.1' ||
    address === '::1' ||
    address === '::ffff:127.0.0.1'
  )
}

function isAuthorized(req) {
  if (!token) return true
  const header = req.headers['authorization'] || ''
  const match = /^Bearer\s+(.+)$/i.exec(header)
  return Boolean(match && match[1] === token)
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(data))
}

function handleSign(req, res) {
  const namespace = (req.headers[namespaceHeader.toLowerCase()] || '').trim()
  if (!namespace) {
    sendJson(res, 400, { error: `missing namespace header: ${namespaceHeader}` })
    return
  }

  const chunks = []
  let size = 0
  let aborted = false
  req.on('data', (chunk) => {
    size += chunk.length
    if (size > MAX_BODY_BYTES) {
      aborted = true
      sendJson(res, 413, { error: 'payload too large' })
      req.destroy()
      return
    }
    chunks.push(chunk)
  })
  req.on('error', (err) => {
    if (!res.headersSent) sendJson(res, 500, { error: 'request error' })
  })
  req.on('end', () => {
    if (aborted || res.headersSent) return
    try {
      const signature = signData(Buffer.concat(chunks), namespace)
      res.writeHead(200, {
        'Content-Type': 'application/vnd.git.ssh-signature',
        'X-Nexos-Git-Sign-Key': pubKeyLine,
      })
      res.end(signature)
      console.log(
        `[nexos:git-sign] signed ${size} byte(s) for namespace "${namespace}" (${hashalg})`,
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      sendJson(res, 500, { error: message })
    }
  })
}

const server = http.createServer((req, res) => {
  const url = req.url || '/'
  const address = req.socket?.remoteAddress || ''
  if (!isLocalhost(address) && !isAuthorized(req)) {
    sendJson(res, 401, { error: 'Unauthorized' })
    return
  }
  if (req.method === 'GET' && url === '/health') {
    sendJson(res, 200, { ok: true })
    return
  }
  if (req.method === 'GET' && url === '/pubkey') {
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end(`${pubKeyLine}\n`)
    return
  }
  if (req.method === 'POST' && url === '/sign') {
    handleSign(req, res)
    return
  }
  if (url === '/health' || url === '/pubkey' || url === '/sign') {
    sendJson(res, 405, { error: 'Method not allowed' })
    return
  }
  sendJson(res, 404, { error: `Unknown endpoint: ${url}` })
})

server.on('error', (err) => {
  console.error(`[nexos:git-sign] server error: ${err.message}`)
  process.exit(1)
})

server.listen(PORT, host, () => {
  console.log(
    `[nexos:git-sign] listening on ${host}:${PORT} (${hashalg}, ${SIGNATURE_TYPE})`,
  )
  console.log(`[nexos:git-sign] public key: ${pubKeyLine}`)
})

function shutdown() {
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 1000).unref()
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
