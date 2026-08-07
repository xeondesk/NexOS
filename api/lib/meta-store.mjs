// NexOS v0-compatible API gateway (Phase 3): small persisted collections.
//
// Generic object-keyed JSON store for the meta resources (mcp-servers,
// webhooks, preview-hosts) plus an append-only line log (webhook deliveries).
// Writes are atomic (tmp file + rename) and synchronous, mirroring the
// chat-store pattern. Files live under NEXOS_API_STATE_DIR.

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

export function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`
}

/** Opens (or creates) a collection persisted at `<dir>/<filename>.json`. */
export function openCollection(dir, filename) {
  const file = path.join(dir, `${filename}.json`)
  let data = {}
  try {
    const raw = fs.readFileSync(file, 'utf8')
    if (raw.trim()) data = JSON.parse(raw)
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
  }

  function save() {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2))
    fs.renameSync(tmp, file)
  }

  return {
    file,
    list() {
      return Object.values(data).sort((a, b) =>
        String(a.createdAt).localeCompare(String(b.createdAt))
      )
    },
    get(id) {
      return data[id] || null
    },
    create(record) {
      data[record.id] = record
      save()
      return record
    },
    update(id, patch) {
      const current = data[id]
      if (!current) return null
      const next = { ...current, ...patch, id: current.id }
      data[id] = next
      save()
      return next
    },
    remove(id) {
      if (!(id in data)) return false
      delete data[id]
      save()
      return true
    },
    raw() {
      return data
    },
  }
}

/** Appends one line to `<dir>/<filename>.jsonl` (flush-on-append). */
export function appendLine(dir, filename, obj) {
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${filename}.jsonl`)
  fs.appendFileSync(file, JSON.stringify(obj) + '\n')
}

/** Reads back all lines of a jsonl log (best-effort, skips corrupt lines). */
export function readLines(dir, filename) {
  const file = path.join(dir, `${filename}.jsonl`)
  try {
    return fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line)
        } catch {
          return null
        }
      })
      .filter(Boolean)
  } catch (err) {
    if (err.code === 'ENOENT') return []
    throw err
  }
}
