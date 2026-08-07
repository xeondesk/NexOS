// Dependency-free ZIP writer for `chats.downloadFiles`.
//
// Emits a stored (method 0, no compression) archive with UTF-8 filename flag
// set and POSIX file modes in the external-attribute field, so both the v0 SDK
// downloader and stock `unzip` handle it. Input entries follow the chat-store
// files record shape: `{ path, content, encoding: 'utf8' | 'base64' }`.

const CRC_TABLE = new Uint32Array(256)
for (let n = 0; n < 256; n++) {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  CRC_TABLE[n] = c >>> 0
}

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function toData(entry) {
  const encoding = entry.encoding === 'base64' ? 'base64' : 'utf8'
  if (encoding === 'base64') {
    return Buffer.from(String(entry.content ?? ''), 'base64')
  }
  return Buffer.from(String(entry.content ?? ''), 'utf8')
}

/** Normalizes an entry path to a safe relative `a/b/c` form (or null if bad). */
function safePath(raw) {
  if (typeof raw !== 'string') return null
  const parts = raw.split(/[\\/]+/).filter((p) => p && p !== '.' && p !== '..')
  if (!parts.length) return null
  return parts.join('/')
}

function lfh(offset, name, size, crc) {
  const nameBuf = Buffer.from(name, 'utf8')
  const head = Buffer.alloc(30)
  head.writeUInt32LE(0x04034b50, 0)
  head.writeUInt16LE(20, 4) // version needed
  head.writeUInt16LE(0x0800, 6) // UTF-8 flag
  head.writeUInt16LE(0, 8) // stored
  head.writeUInt16LE(0, 10) // time
  head.writeUInt16LE(0x0021, 12) // date 1980-01-01
  head.writeUInt32LE(crc, 14)
  head.writeUInt32LE(size, 18)
  head.writeUInt32LE(size, 22)
  head.writeUInt16LE(nameBuf.length, 26)
  head.writeUInt16LE(0, 28) // extra
  return { head, nameBuf, offset }
}

function cdEntry(name, size, crc, localOffset, isDir) {
  const nameBuf = Buffer.from(name, 'utf8')
  const rec = Buffer.alloc(46)
  rec.writeUInt32LE(0x02014b50, 0)
  rec.writeUInt16LE(20, 4) // version made by
  rec.writeUInt16LE(20, 6) // version needed
  rec.writeUInt16LE(0x0800, 8) // UTF-8 flag
  rec.writeUInt16LE(0, 10) // stored
  rec.writeUInt16LE(0, 12) // time
  rec.writeUInt16LE(0x0021, 14) // date
  rec.writeUInt32LE(crc, 16)
  rec.writeUInt32LE(size, 20)
  rec.writeUInt32LE(size, 24)
  rec.writeUInt16LE(nameBuf.length, 28)
  rec.writeUInt16LE(0, 30) // extra
  rec.writeUInt16LE(0, 32) // comment
  rec.writeUInt16LE(0, 34) // disk
  rec.writeUInt16LE(0, 36) // internal attrs
  rec.writeUInt32LE(isDir ? 0o755 << 16 | 0x10 : 0o644 << 16, 38) // external attrs
  rec.writeUInt32LE(localOffset, 42)
  return Buffer.concat([rec, nameBuf])
}

/**
 * Builds a ZIP archive Buffer from a files-record array.
 * @param {Array<{path:string, content:string, encoding?:string}>} files
 * @returns {Buffer}
 */
export function buildZip(files) {
  const entries = (files || [])
    .map((f) => ({ name: safePath(f.path), data: toData(f) }))
    .filter((e) => e.name !== null)

  const dirNames = new Set()
  for (const e of entries) {
    const parts = e.name.split('/')
    for (let i = 1; i < parts.length; i++) {
      dirNames.add(parts.slice(0, i).join('/') + '/')
    }
  }

  const chunks = []
  const central = []
  let offset = 0

  for (const name of [...dirNames].sort()) {
    const nameBuf = Buffer.from(name, 'utf8')
    const { head } = lfh(offset, name, 0, 0)
    const record = cdEntry(name, 0, 0, offset, true)
    chunks.push(head, nameBuf)
    central.push(record)
    offset += head.length + nameBuf.length
  }

  for (const e of entries) {
    const crc = crc32(e.data)
    const { head, nameBuf } = lfh(offset, e.name, e.data.length, crc)
    const record = cdEntry(e.name, e.data.length, crc, offset, false)
    chunks.push(head, nameBuf, e.data)
    central.push(record)
    offset += head.length + nameBuf.length + e.data.length
  }

  const cdSize = central.reduce((n, b) => n + b.length, 0)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(central.length, 8)
  eocd.writeUInt16LE(central.length, 10)
  eocd.writeUInt32LE(cdSize, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)

  return Buffer.concat([...chunks, ...central, eocd])
}
