// JSON (non-streaming) chat/message handlers for the v2 API gateway (Phase 2).
//
// Covers chats + messages CRUD, async variants (immediate completion on the
// mock backend — the contract only requires 202 + IDs), source-file ingestion
// (from-files/from-zip/from-repo) and the files endpoints. Returns
// `{ status, json }` for the router to serialize.

import * as store from './chat-store.mjs'
import { mockResponse } from './mock-generator.mjs'
import { extractZip, extractRepo, toFilesRecord } from './from.mjs'
import { openCollection } from './meta-store.mjs'
import { buildZip } from './zip.mjs'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Creates a chat + user message + mock assistant turn; returns { chat, usage }. */
function createChatWithAssistant({ message, title, privacy, metadata } = {}) {
  const state = mockResponse(message)
  const { chat } = store.createChat({ message, title: title || state.title, privacy, metadata })
  const assistant = store.addAssistant(chat.id, {
    parts: state.parts,
    content: state.text,
    usage: store.usageFor(state.text, message),
  })
  return { chat, usage: assistant.usage }
}

function chatWithUsage(chat, usage) {
  return { status: 200, json: { chat: store.toChatApi(chat), usage } }
}

function parseJsonQuery(value) {
  if (!value) return undefined
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}

function normalizeFiles(files) {
  return (files || []).map((file) => ({
    path: String(file.path),
    content: String(file.content),
    encoding: file.encoding === 'base64' ? 'base64' : 'utf8',
  }))
}

function fileSummary(files) {
  const count = files.length
  return `Created from ${count} source file${count === 1 ? '' : 's'}`
}

// ---------------------------------------------------------------------------
// Chats
// ---------------------------------------------------------------------------

export function chatsCreate({ body }) {
  const { message, title, privacy, metadata } = body
  const { chat, usage } = createChatWithAssistant({ message, title, privacy, metadata })
  return chatWithUsage(chat, usage)
}

export function chatsCreateAsync({ body }) {
  const { message, title, privacy, metadata } = body
  const state = mockResponse(message)
  const { chat } = store.createChat({ message, title: title || state.title, privacy, metadata })
  const assistant = store.addAssistant(chat.id, {
    parts: state.parts,
    content: state.text,
    usage: store.usageFor(state.text, message),
  })
  return { status: 202, json: { chatId: chat.id, messageId: assistant.id } }
}

export function chatsList({ query }) {
  const limit = parseInt(query.limit || '50', 10) || 50
  const { chats, cursor } = store.listChats({
    limit,
    cursor: query.cursor,
    authorId: query.authorId,
    vercelProjectId: query.vercelProjectId,
    metadata: parseJsonQuery(query.metadata),
  })
  return { status: 200, json: { chats: chats.map(store.toChatApi), cursor } }
}

export function chatsGet({ params }) {
  const chat = store.getChat(params.chatId)
  if (!chat) return { status: 404, json: { message: 'chat_not_found' } }
  return { status: 200, json: store.toChatApi(chat) }
}

export function chatsUpdate({ params, body }) {
  const chat = store.updateChat(params.chatId, body)
  if (!chat) return { status: 404, json: { message: 'chat_not_found' } }
  return { status: 200, json: store.toChatApi(chat) }
}

export function chatsDelete({ params }) {
  if (!store.deleteChat(params.chatId)) {
    return { status: 404, json: { message: 'chat_not_found' } }
  }
  return { status: 200, json: { chatId: params.chatId } }
}

export function chatsDuplicate({ params, body }) {
  const copy = store.duplicateChat(params.chatId, body)
  if (!copy) return { status: 404, json: { message: 'chat_not_found' } }
  return { status: 201, json: store.toChatApi(copy) }
}

export function chatsRestoreMessage({ params, body }) {
  const chat = store.getChat(params.chatId)
  if (!chat) return { status: 404, json: { message: 'chat_not_found' } }
  const message = store.markRestorable(params.chatId, body.messageId)
  if (!message) return { status: 404, json: { message: 'message_not_found' } }
  return { status: 200, json: { messages: store.getMessages(params.chatId) } }
}

// ---------------------------------------------------------------------------
// Source-file ingestion
// ---------------------------------------------------------------------------

export async function chatsCreateFromFiles({ body }) {
  const { files, title, privacy, metadata } = body
  const normalized = normalizeFiles(files)
  const { chat, usage } = createChatWithAssistant({
    message: fileSummary(normalized),
    title,
    privacy,
    metadata,
  })
  store.setFiles(chat.id, normalized)
  return chatWithUsage(chat, usage)
}

export async function chatsCreateFromZip({ body }) {
  const { url, title, privacy, metadata } = body
  const { chat, usage } = createChatWithAssistant({
    message: 'Created from a zip archive',
    title,
    privacy,
    metadata,
  })
  try {
    const { dir, rels } = await extractZip(chat.id, url)
    store.setFiles(chat.id, toFilesRecord(dir, rels))
  } catch (err) {
    store.deleteChat(chat.id)
    return { status: 422, json: { message: err.message || 'invalid_zip' } }
  }
  return chatWithUsage(chat, usage)
}

export async function chatsCreateFromRepo({ body }) {
  const { repo, title, privacy, metadata } = body
  const { chat, usage } = createChatWithAssistant({
    message: 'Created from a git repository',
    title,
    privacy,
    metadata,
  })
  try {
    const { dir, rels } = extractRepo(chat.id, repo)
    store.setFiles(chat.id, toFilesRecord(dir, rels))
  } catch (err) {
    store.deleteChat(chat.id)
    return { status: 422, json: { message: err.message || 'invalid_repo' } }
  }
  return chatWithUsage(chat, usage)
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

export function chatsGetFiles({ params }) {
  const chat = store.getChat(params.chatId)
  if (!chat) return { status: 404, json: { message: 'chat_not_found' } }
  return { status: 200, json: store.getFiles(params.chatId) }
}

export function chatsUpdateFiles({ params, body }) {
  const chat = store.getChat(params.chatId)
  if (!chat) return { status: 404, json: { message: 'chat_not_found' } }
  store.setFiles(params.chatId, normalizeFiles(body.files))
  return { status: 200, json: store.getFiles(params.chatId) }
}

export function chatsDownloadFiles({ params }) {
  const chat = store.getChat(params.chatId)
  if (!chat) return { status: 404, json: { message: 'chat_not_found' } }
  const files = store.getFiles(params.chatId).files || []
  const archive = buildZip(files)
  return {
    status: 200,
    stream: (res) => {
      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${params.chatId}.zip"`,
        'Content-Length': archive.length,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      })
      res.end(archive)
    },
  }
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export function messagesList({ params, query }) {
  const chat = store.getChat(params.chatId)
  if (!chat) return { status: 404, json: { message: 'chat_not_found' } }
  const limit = parseInt(query.limit || '50', 10) || 50
  const { messages, cursor } = store.listMessages(params.chatId, { limit, cursor: query.cursor })
  return { status: 200, json: { messages, cursor } }
}

export function messagesSend({ params, body }) {
  const chat = store.getChat(params.chatId)
  if (!chat) return { status: 404, json: { message: 'chat_not_found' } }
  const { message } = body
  store.addMessage(chat.id, { role: 'user', content: message })
  const state = mockResponse(message)
  const assistant = store.addAssistant(chat.id, {
    parts: state.parts,
    content: state.text,
    usage: store.usageFor(state.text, message),
  })
  return { status: 200, json: assistant }
}

export function messagesSendAsync({ params, body }) {
  const chat = store.getChat(params.chatId)
  if (!chat) return { status: 404, json: { message: 'chat_not_found' } }
  const { message } = body
  store.addMessage(chat.id, { role: 'user', content: message })
  const state = mockResponse(message)
  const assistant = store.addAssistant(chat.id, {
    parts: state.parts,
    content: state.text,
    usage: store.usageFor(state.text, message),
  })
  return { status: 202, json: { messageId: assistant.id } }
}

export function messagesGet({ params }) {
  const message = store.getMessage(params.messageId)
  if (!message || message.chatId !== params.chatId) {
    return { status: 404, json: { message: 'message_not_found' } }
  }
  return { status: 200, json: message }
}

export function messagesStop({ params }) {
  const message = store.getMessage(params.messageId)
  if (!message || message.chatId !== params.chatId) {
    return { status: 404, json: { message: 'message_not_found' } }
  }
  return { status: 200, json: { messageId: params.messageId } }
}

// ---------------------------------------------------------------------------
// Vercel Connect setup status
// ---------------------------------------------------------------------------

function connectorsCollection() {
  return openCollection(store.stateDirPath(), 'connectors')
}

/**
 * Records connector setup state keyed by the `requestId` from a
 * `configure_vercel_connect` action (used by `chats.getConnectStatus`).
 * Not a spec'd op — callers seed it (or drop a `connectors/<id>.json` file)
 * to drive the pending -> ready/error transition deterministically.
 */
export function setConnectorStatus(requestId, record) {
  const collection = connectorsCollection()
  return collection.update(requestId, { ...record, id: requestId, updatedAt: new Date().toISOString() })
    || collection.create({ ...record, id: requestId, createdAt: new Date().toISOString() })
}

export function chatsGetConnectStatus({ params, query }) {
  const chat = store.getChat(params.chatId)
  if (!chat) return { status: 404, json: { message: 'chat_not_found' } }
  const record = connectorsCollection().get(query.requestId)
  if (record && record.status === 'ready' && record.connector) {
    return { status: 200, json: { status: 'ready', connector: record.connector } }
  }
  if (record && record.status === 'pending') {
    return { status: 200, json: { status: 'pending', progress: record.progress || 'setting up connector' } }
  }
  if (record && record.status === 'error' && record.message) {
    return { status: 200, json: { status: 'error', message: record.message } }
  }
  return { status: 200, json: { status: 'error', message: 'vercel_connect_not_configured' } }
}
