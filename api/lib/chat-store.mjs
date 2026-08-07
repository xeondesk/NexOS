// Minimal in-memory chat/message store for the v2 API gateway.
// Phase 1: in-memory only (no persistence); Phase 2 adds durable state under
// NEXOS_API_STATE_DIR.

import crypto from 'node:crypto'

export function newId(prefix) {
  return `${prefix}${crypto.randomBytes(8).toString('hex')}`
}

export const zeroUsage = () => ({
  tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  creditsCost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
})

const DEFAULT_PRIVACY = 'private'
const DEFAULT_AUTHOR = 'local'

const chats = new Map()
const messagesByChat = new Map()
const messagesById = new Map()

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

/** Creates a chat plus the user's first message; returns { chat, userMessage }. */
export function createChat({ message, title = '', privacy, metadata } = {}) {
  const chat = chatRecord({ title, privacy, metadata })
  const userMessage = messageRecord(chat.id, { role: 'user', content: message })
  chats.set(chat.id, chat)
  pushMessage(chat.id, userMessage)
  return { chat, userMessage }
}

/** Appends a message to an existing chat (the chat's updatedAt bumps). */
export function addMessage(chatId, { role, content = '', parts = [], usage, finishReason } = {}) {
  const chat = chats.get(chatId)
  if (!chat) return null
  const message = messageRecord(chatId, { role, content, parts, usage, finishReason })
  pushMessage(chatId, message)
  chat.updatedAt = nowIso()
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

export function getChat(chatId) {
  return chats.get(chatId) || null
}

export function listChats() {
  return [...chats.values()]
}

export function getMessage(messageId) {
  return messagesById.get(messageId) || null
}

export function listMessages(chatId) {
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

/** Serializes a store chat to the v2 `Chat` shape. */
export function toChatApi(chat) {
  const { id, title, privacy, createdAt, updatedAt, authorId, vercelProjectId, metadata, writePermission } = chat
  return { id, title, privacy, createdAt, updatedAt, authorId, vercelProjectId, metadata, writePermission }
}
