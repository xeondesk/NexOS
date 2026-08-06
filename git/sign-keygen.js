#!/usr/bin/env node
// NexOS git-sign keypair generator.
//
// Emits an ed25519 keypair for the reference signing service:
//
//   node git/sign-keygen.js [out-dir]     (default: state/sign)
//
//   sign-key.pem  — private key, PKCS#8 PEM (what NEXOS_GIT_SIGN_KEY points at)
//   sign-key.pub  — public key, OpenSSH format (the line to add to an
//                   allowed-signers file, prefixed with a principal/identity)
//
// The private key never leaves the host running the sign service; git clients
// only ever hold the public key.
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const outDir = process.argv[2] || 'state/sign'
fs.mkdirSync(outDir, { recursive: true })
const privPath = path.join(outDir, 'sign-key.pem')
const pubPath = path.join(outDir, 'sign-key.pub')

const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519')
const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' })
const jwk = publicKey.export({ format: 'jwk' })
const pubRaw = Buffer.from(jwk.x, 'base64url')

function sshString(buf) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(buf.length)
  return Buffer.concat([len, buf])
}

const pubWire = Buffer.concat([
  sshString(Buffer.from('ssh-ed25519')),
  sshString(pubRaw),
])
const pubLine = `ssh-ed25519 ${pubWire.toString('base64')} nexos-git-sign`

fs.writeFileSync(privPath, privPem, { mode: 0o600 })
fs.writeFileSync(pubPath, `${pubLine}\n`, { mode: 0o644 })

console.log(`wrote ${privPath} (private, PKCS#8 PEM)`)
console.log(`wrote ${pubPath} (public, OpenSSH format)`)
console.log('allowed-signers entry (replace <identity>):')
console.log(`  <identity> ${pubLine}`)
console.log('configure the sign service with:')
console.log(`  NEXOS_GIT_SIGN_KEY=${privPath}`)
