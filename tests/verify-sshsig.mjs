// Reference SSH signature verifier — a faithful, dependency-free reimplementation
// of `ssh-keygen -Y verify` for ed25519 signatures, used by the sign-server smoke
// test as an independent oracle.
//
// Why this exists: Amazon Linux 2023 ships OpenSSH 8.7p1 against OpenSSL 3.5.5,
// whose `ssh-keygen -Y verify` rejects every signature (including ssh-keygen's
// own) with "Signature verification failed: incorrect signature" — a tool
// regression in this environment, not a signature defect. This verifier parses
// the exact same SSHSIG wire format and does the same ed25519 crypto check that
// ssh-keygen performs, so it asserts real git-interop correctness anywhere.
//
// Usage (ssh-keygen -Y verify compatible flags):
//   node verify-sshsig.mjs -f <allowed-signers> -I <identity> -n <namespace> \
//                           -s <signature-file> <data-file>
//
// The signed bytes follow the OpenSSH ssh-sign format with plain RFC 4251
// strings (no trailing NUL), matching OpenSSH 8.7:
//
//   tosign = "SSHSIG" + string(namespace) + string("") + string(hashalg)
//            + string(H(hashalg, data))
//
//   blob = "SSHSIG" + u32(1) + string(pubkey) + string(namespace)
//          + string("") + string(hashalg) + string(sigblob)

import fs from 'fs'
import crypto from 'crypto'

const args = process.argv.slice(2)
let signersFile, identity, namespace, sigFile, dataFile
for (let i = 0; i < args.length; i++) {
  if (args[i] === '-f') signersFile = args[++i]
  else if (args[i] === '-I') identity = args[++i]
  else if (args[i] === '-n') namespace = args[++i]
  else if (args[i] === '-s') sigFile = args[++i]
  else dataFile = args[i]
}

function fail(message) {
  console.error(`Could not verify signature. (${message})`)
  process.exit(1)
}

if (!signersFile || !identity || !namespace || !sigFile || !dataFile) {
  console.error('usage: node verify-sshsig.mjs -f <allowed-signers> -I <identity> -n <namespace> -s <signature> <data>')
  process.exit(2)
}

function u32(value) {
  const buf = Buffer.alloc(4)
  buf.writeUInt32BE(value)
  return buf
}

function sshString(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf)
  return Buffer.concat([u32(b.length), b])
}

// ---- unarmor + parse the SSHSIG blob ----
const armor = fs.readFileSync(sigFile, 'utf8')
const b64 = armor
  .split('\n')
  .filter((line) => !line.startsWith('-----'))
  .join('')
const blob = Buffer.from(b64, 'base64')

function readString(buf, off) {
  if (off + 4 > buf.length) throw new Error('truncated string length')
  const len = buf.readUInt32BE(off)
  off += 4
  if (off + len > buf.length) throw new Error('truncated string')
  return [buf.slice(off, off + len), off + len]
}

let off = 0
let version
let pubKeyWire, sigNamespace, reserved, sigHashalg, sigBlob
try {
  if (blob.subarray(0, 6).toString('latin1') !== 'SSHSIG') throw new Error('missing SSHSIG header')
  off = 6
  if (off + 4 > blob.length) throw new Error('truncated version')
  version = blob.readUInt32BE(off)
  off += 4
  ;[pubKeyWire, off] = readString(blob, off)
  ;[sigNamespace, off] = readString(blob, off)
  ;[reserved, off] = readString(blob, off)
  ;[sigHashalg, off] = readString(blob, off)
  ;[sigBlob, off] = readString(blob, off)
} catch (err) {
  fail(`invalid signature format: ${err.message}`)
}
if (version !== 1) {
  fail(`unrecognized signature version ${version}`)
}
if (reserved.length !== 0) {
  fail('reserved field not empty')
}
if (sigNamespace.toString() !== namespace) {
  fail(`namespace mismatch (signature is for "${sigNamespace}", verifying for "${namespace}")`)
}

// ---- sigblob = string(keytype) + string(raw signature) ----
let sigOff = 0
let sigKeytype, rawSig
try {
  ;[sigKeytype, sigOff] = readString(sigBlob, sigOff)
  ;[rawSig, sigOff] = readString(sigBlob, sigOff)
} catch (err) {
  fail(`invalid signature blob: ${err.message}`)
}

// ---- pubkey = string(keytype) + string(ed25519 key material) ----
let keyOff = 0
let pubKeytype, pubKeyMaterial
try {
  ;[pubKeytype, keyOff] = readString(pubKeyWire, keyOff)
  ;[pubKeyMaterial, keyOff] = readString(pubKeyWire, keyOff)
} catch (err) {
  fail(`invalid public key: ${err.message}`)
}
if (pubKeytype.toString() !== sigKeytype.toString() || pubKeytype.toString() !== 'ssh-ed25519') {
  fail(`unsupported key type ${pubKeytype}`)
}

// ---- match identity against allowed-signers ----
// Format: [options] principals keytype base64key [comment]. Locate the
// keytype field rather than assuming a fixed column count, so trailing
// comments (e.g. sign-keygen's "nexos-git-sign") parse correctly.
const wireBase64 = pubKeyWire.toString('base64')
let principalMatch = false
for (const line of fs.readFileSync(signersFile, 'utf8').split('\n')) {
  const fields = line.trim().split(/\s+/)
  const keyIdx = fields.findIndex((f) => f === 'ssh-ed25519')
  if (keyIdx < 1 || keyIdx + 1 >= fields.length) continue
  const principals = fields[keyIdx - 1]
  if (fields[keyIdx + 1] !== wireBase64) continue
  const allowed = principals.split(',').map((p) => p.trim())
  if (principals === '*' || allowed.includes(identity)) principalMatch = true
}
if (!principalMatch) {
  fail(`no principal "${identity}" matched for the signer public key`)
}

// ---- crypto check over the exact bytes ssh-keygen signs ----
const hashalg = sigHashalg.toString()
const hash = crypto.createHash(hashalg).update(fs.readFileSync(dataFile)).digest()
const tosign = Buffer.concat([
  Buffer.from('SSHSIG'),
  sshString(sigNamespace),
  sshString(Buffer.alloc(0)),
  sshString(sigHashalg),
  sshString(hash),
])

const spki = Buffer.concat([
  Buffer.from('302a300506032b6570032100', 'hex'),
  pubKeyMaterial,
])
const publicKey = crypto.createPublicKey({ key: spki, format: 'der', type: 'spki' })
if (!crypto.verify(null, tosign, publicKey, rawSig)) {
  fail(`incorrect signature (${hashalg} over ${sigNamespace})`)
}

console.log(`Good "git" signature for ${identity} with ${pubKeytype} key SHA256:${crypto
  .createHash('sha256')
  .update(pubKeyWire)
  .digest('hex')}`)
process.exit(0)
