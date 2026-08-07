// Chat/message store for the v2 API gateway (Phase 2: persistent).
//
// Records live in memory and are mirrored to `state/api/` on every mutation
// with atomic tmp+rename writes (one JSON file per chat, plus one per chat for
// source files). On startup the store reloads whatever exists, so chats and
// messages survive service restarts.
//
// Layout under NEXOS_API_STATE_DIR:
//   chats/<chatId>.json    { chat, messages: [...] }
//   files/<chatId>.json    { files: [{ path, content, encoding }] }
//   workspace/<chatId>/    extracted zips / cloned repos (from-zip/from-repo)

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const DEFAULT_PRIVACY = 'private'
const DEFAULT_AUTHOR = 'local'

let stateDir = null
const chats = new Map()
const messagesByChat = new Map()
const messagesById = new Map()
const filesByChat = new Map()

// ---------------------------------------------------------------------------
// IDs / usage
// ---------------------------------------------------------------------------

export function newId(prefix) {
  return `${prefix}${crypto.randomBytes(8).toString('hex')}`
}

export const zeroUsage = () => ({
  tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  creditsCost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
})

/** Mock usage derived from prompt/output lengths. */
export function usageFor(text, prompt) {
  const input = Math.max(1, Math.round(String(prompt || '').length / 4))
  const output = Math.max(1, Math.round(text.length / 4))
  return {
    tokens: { input, output, cacheRead: 0, cacheWrite: 0, total: input + output },
    creditsCost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  }
}

// ---------------------------------------------------------------------------
// Init / persistence
// ---------------------------------------------------------------------------

export function initStore({ dir }) {
  stateDir = dir
  fs.mkdirSync(path.join(dir, 'chats'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'files'), { recursive: true })
  loadChats()
  loadFiles()
}

export function stateDirPath() {
  return stateDir
}

function chatsDir() {
  return path.join(stateDir, 'chats')
}

function filesDir() {
  return path.join(stateDir, 'files')
}

function chatFile(chatId) {
  return path.join(chatsDir(), `${chatId}.json`)
}

function filesFile(chatId) {
  return path.join(filesDir(), `${chatId}.json`)
}

function atomicWrite(file, data) {
  if (!stateDir) return
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2))
  fs.renameSync(tmp, file)
}

function persist(chatId) {
  atomicWrite(chatFile(chatId), { chat: chats.get(chatId), messages: messagesByChat.get(chatId) || [] })
}

function persistFiles(chatId) {
  const record = filesByChat.get(chatId)
  if (record) atomicWrite(filesFile(chatId), record)
}

function loadChats() {
  for (const entry of fs.readdirSync(chatsDir())) {
    if (!entry.endsWith('.json')) continue
    try {
      const record = JSON.parse(fs.readFileSync(path.join(chatsDir(), entry), 'utf8'))
      if (!record || !record.chat?.id) continue
      const chat = record.chat
      const messages = record.messages || []
      chats.set(chat.id, chat)
      messagesByChat.set(chat.id, messages)
      for (const message of messages) messagesById.set(message.id, message)
    } catch {
      // skip corrupt records
    }
  }
}

function loadFiles() {
  for (const entry of fs.readdirSync(filesDir())) {
    if (!entry.endsWith('.json')) continue
    try {
      const record = JSON.parse(fs.readFileSync(path.join(filesDir(), entry), 'utf8'))
      filesByChat.set(entry.replace(/\.json$/, ''), record)
    } catch {
      // skip corrupt records
    }
  }
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

function nowIso() {
  return new Date().toISOString()
}

function chatRecord({ title = '', privacy = DEFAULT_PRIVACY, metadata = {} } = {}) {
  const ts = nowIso()
  return {
    id: newId('chat_'),
    title,
    privacy,
    createdAt: ts,
    updatedAt: ts,
    authorId: DEFAULT_AUTHOR,
    vercelProjectId: null,
    metadata,
    writePermission: true,
  }
}

function messageRecord(chatId, { role, content = '', parts = [], usage = zeroUsage(), finishReason = null } = {}) {
  const ts = nowIso()
  return {
    id: newId('msg_'),
    chatId,
    role,
    createdAt: ts,
    updatedAt: ts,
    content,
    parts,
    finishReason,
    restorable: role === 'assistant',
    attachments: [],
    authorId: DEFAULT_AUTHOR,
    usage,
  }
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/** Creates a chat plus the user's first message; returns { chat, userMessage }. */
export function createChat({ message, title = '', privacy, metadata } = {}) {
  const chat = chatRecord({ title, privacy, metadata })
  const userMessage = messageRecord(chat.id, { role: 'user', content: message })
  chats.set(chat.id, chat)
  pushMessage(chat.id, userMessage)
  persist(chat.id)
  return { chat, userMessage }
}

/** Appends a message to an existing chat (the chat's updatedAt bumps). */
export function addMessage(chatId, { role, content = '', parts = [], usage, finishReason } = {}) {
  const chat = chats.get(chatId)
  if (!chat) return null
  const message = messageRecord(chatId, { role, content, parts, usage, finishReason })
  pushMessage(chatId, message)
  chat.updatedAt = nowIso()
  persist(chatId)
  return message
}

/** Adds an assistant message carrying the final parts + usage. */
export function addAssistant(chatId, { parts = [], content = '', usage = zeroUsage() } = {}) {
  return addMessage(chatId, { role: 'assistant', content, parts, usage, finishReason: 'stop' })
}

function pushMessage(chatId, message) {
  const list = messagesByChat.get(chatId) || []
  list.push(message)
  messagesByChat.set(chatId, list)
  messagesById.set(message.id, message)
}

/** Partial update of a chat's title/privacy/metadata. */
export function updateChat(chatId, { title, privacy, metadata } = {}) {
  const chat = chats.get(chatId)
  if (!chat) return null
  if (title !== undefined) chat.title = title
  if (privacy !== undefined) chat.privacy = privacy
  if (metadata !== undefined) chat.metadata = metadata
  chat.updatedAt = nowIso()
  persist(chatId)
  return chat
}

/** Links a local Vercel-equivalent project to a chat (persisted). */
export function linkProject(chatId, projectId) {
  const chat = chats.get(chatId)
  if (!chat) return null
  chat.vercelProjectId = projectId
  chat.updatedAt = nowIso()
  persist(chatId)
  return chat
}

export function deleteChat(chatId) {
  if (!chats.has(chatId)) return false
  chats.delete(chatId)
  messagesByChat.delete(chatId)
  filesByChat.delete(chatId)
  for (const id of [...messagesById.keys()]) {
    if (messagesById.get(id)?.chatId === chatId) messagesById.delete(id)
  }
  for (const file of [chatFile(chatId), filesFile(chatId)]) {
    try {
      fs.unlinkSync(file)
    } catch {
      // already gone
    }
  }
  return true
}

/** Duplicates a chat (new ids, same messages/files). */
export function duplicateChat(chatId, { title, privacy } = {}) {
  const source = chats.get(chatId)
  if (!source) return null
  const copy = chatRecord({
    title: title ?? `${source.title || 'Chat'} (copy)`,
    privacy: privacy ?? source.privacy,
    metadata: JSON.parse(JSON.stringify(source.metadata || {})),
  })
  chats.set(copy.id, copy)
  const copiedMessages = (messagesByChat.get(chatId) || []).map((m) =>
    messageRecord(copy.id, {
      role: m.role,
      content: m.content,
      parts: JSON.parse(JSON.stringify(m.parts || [])),
      usage: JSON.parse(JSON.stringify(m.usage || zeroUsage())),
      finishReason: m.finishReason,
    }),
  )
  for (const message of copiedMessages) pushMessage(copy.id, message)
  const sourceFiles = filesByChat.get(chatId)
  if (sourceFiles) filesByChat.set(copy.id, JSON.parse(JSON.stringify(sourceFiles)))
  persist(copy.id)
  persistFiles(copy.id)
  return copy
}

/** Marks an assistant message restorable again (restore-message). */
export function markRestorable(chatId, messageId) {
  const message = messagesById.get(messageId)
  if (!message || message.chatId !== chatId) return null
  message.restorable = true
  persist(chatId)
  return message
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export function getChat(chatId) {
  return chats.get(chatId) || null
}

export function listChats({ limit = 50, cursor, authorId, vercelProjectId, metadata } = {}) {
  let items = [...chats.values()]
  if (authorId) items = items.filter((chat) => chat.authorId === authorId)
  if (vercelProjectId) items = items.filter((chat) => (chat.vercelProjectId ?? null) === vercelProjectId)
  if (metadata && typeof metadata === 'object') {
    items = items.filter((chat) =>
      Object.entries(metadata).every(([key, value]) => chat.metadata?.[key] === value),
    )
  }
  items.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
  const start = cursor ? parseInt(cursor, 10) || 0 : 0
  const slice = items.slice(start, start + limit)
  const next = start + slice.length < items.length ? String(start + slice.length) : null
  return { chats: slice, cursor: next }
}

export function getMessage(messageId) {
  return messagesById.get(messageId) || null
}

export function listMessages(chatId, { limit = 50, cursor } = {}) {
  const list = messagesByChat.get(chatId) || []
  const start = cursor ? parseInt(cursor, 10) || 0 : 0
  const slice = list.slice(start, start + limit)
  const next = start + slice.length < list.length ? String(start + slice.length) : null
  return { messages: slice, cursor: next }
}

/** Raw message array for a chat (internal use). */
export function getMessages(chatId) {
  return messagesByChat.get(chatId) || []
}

/** The last assistant message of a chat, if any (used by /resume). */
export function lastAssistant(chatId) {
  const list = messagesByChat.get(chatId) || []
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].role === 'assistant') return list[i]
  }
  return null
}

// ---------------------------------------------------------------------------
// Source files (from-files / from-zip / from-repo; served by getFiles)
// ---------------------------------------------------------------------------

export function setFiles(chatId, files) {
  const record = { files: files || [] }
  filesByChat.set(chatId, record)
  persistFiles(chatId)
  return record
}

export function getFiles(chatId) {
  const record = filesByChat.get(chatId)
  return record || { files: [] }
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

/** Serializes a store chat to the v2 `Chat` shape. */
export function toChatApi(chat) {
  const { id, title, privacy, createdAt, updatedAt, authorId, vercelProjectId, metadata, writePermission } = chat
  return { id, title, privacy, createdAt, updatedAt, authorId, vercelProjectId, metadata, writePermission }
}
