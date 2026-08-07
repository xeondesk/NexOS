// Source-file ingestion for the v2 API gateway (from-files / from-zip /
// from-repo). Each source lands in `state/api/workspace/<chatId>/` and is
// snapshotted into the files store (`{ path, content, encoding }`), served by
// `chats.getFiles`.

import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import * as store from './chat-store.mjs'

const MAX_FILE_BYTES = 1024 * 1024
const SKIP_SEGMENTS = new Set([
  'node_modules',
  '.git',
  '.next',
  '.vercel',
  'dist',
  'build',
  'out',
  'coverage',
  '.turbo',
  '.venv',
  'venv',
  '__pycache__',
])

export function workspaceDir(chatId) {
  const dir = path.join(store.stateDirPath(), 'workspace', chatId)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function isSkipped(rel) {
  return rel.split('/').some((segment) => SKIP_SEGMENTS.has(segment))
}

function toFilesRecord(dir, relativePaths) {
  const files = []
  for (const rel of relativePaths) {
    if (isSkipped(rel)) continue
    const abs = path.join(dir, rel)
    let stat
    try {
      stat = fs.statSync(abs)
    } catch {
      continue
    }
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) continue
    const buf = fs.readFileSync(abs)
    const normalized = rel.split(path.sep).join('/')
    if (buf.includes(0)) {
      files.push({ path: normalized, content: buf.toString('base64'), encoding: 'base64' })
    } else {
      files.push({ path: normalized, content: buf.toString('utf8'), encoding: 'utf8' })
    }
  }
  files.sort((a, b) => a.path.localeCompare(b.path))
  return files
}

/** Downloads `url` (http/https only) and extracts the zip into the workspace. */
export async function extractZip(chatId, url) {
  if (!/^https?:\/\//i.test(url)) {
    throw new Error('invalid_zip_url')
  }
  const dir = workspaceDir(chatId)
  const tmpZip = path.join(dir, 'source.zip')
  const outDir = path.join(dir, 'extracted')

  const response = await fetch(url)
  if (!response.ok) throw new Error(`download_failed:${response.status}`)
  fs.writeFileSync(tmpZip, Buffer.from(await response.arrayBuffer()))

  fs.mkdirSync(outDir, { recursive: true })
  execFileSync('unzip', ['-q', '-o', tmpZip, '-d', outDir], { stdio: 'ignore' })
  const listing = execFileSync('unzip', ['-Z1', tmpZip], { encoding: 'utf8' })
  const rels = listing
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.endsWith('/'))
  return { dir: outDir, rels }
}

/** Clones `repo.url` (branch optional) into the workspace and lists tracked files. */
export function extractRepo(chatId, { url, branch } = {}) {
  const dir = workspaceDir(chatId)
  const repoDir = path.join(dir, 'repo')
  const args = ['clone', '--depth', '1']
  if (branch) args.push('--branch', branch)
  args.push(url, repoDir)
  execFileSync('git', args, { stdio: 'ignore' })
  const listing = execFileSync('git', ['-C', repoDir, 'ls-files', '-z'], { encoding: 'utf8' })
  const rels = listing.split('\0').filter(Boolean)
  return { dir: repoDir, rels }
}

export { toFilesRecord }
