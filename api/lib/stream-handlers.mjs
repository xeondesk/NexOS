// Streaming handlers for the v2 API gateway.
//
// Implements the v0 wire format for `chats.createStream`, `messages.sendStream`
// and `chats.resume`: raw `ChatStreamEvent` / `MessageStreamEvent` objects,
// each serialized as an SSE `data:` frame (see `formatSse` in v0-stream.mjs).
// The generated SDK client parses these frames and folds them into accumulated
// snapshots via `applyStreamEvent`.
//
// Deterministic mock backend: `mock-generator.mjs` produces final parts plus a
// parts *progression*; consecutive snapshots differ by single text appends, so
// `message.parts.chunk` deltas exercise the v0 append fast-path
// ([[idx, 'text', suffix], 9, 9]) as well as plain jsondiffpatch deltas.

import { diff } from './diffpatch.mjs'
import { formatSse } from './v0-stream.mjs'
import * as store from './chat-store.mjs'
import { mockResponse, partsProgression } from './mock-generator.mjs'

const CHUNK_DELAY_MS = 60

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function sseHeaders() {
  return {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    'X-Content-Type-Options': 'nosniff',
  }
}

function usageFor(text, prompt) {
  const input = Math.max(1, Math.round(String(prompt || '').length / 4))
  const output = Math.max(1, Math.round(text.length / 4))
  return {
    tokens: { input, output, cacheRead: 0, cacheWrite: 0, total: input + output },
    creditsCost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  }
}

function chatEvent(chat) {
  return { object: 'chat', ...store.toChatApi(chat) }
}

function messagePayload(message) {
  const {
    id, chatId, role, createdAt, updatedAt, content, parts,
    finishReason, restorable, attachments, authorId, usage,
  } = message
  return { id, chatId, role, createdAt, updatedAt, content, parts, finishReason, restorable, attachments, authorId, usage }
}

/** The assistant message as it appears in the opening `message` event. */
function openingMessage(message) {
  return { ...messagePayload(message), content: '', parts: [], finishReason: null }
}

/**
 * Writes one SSE `data:` frame carrying a raw stream event, then waits a tick
 * so chunk boundaries are visible to subscribers (the SDK yields events as
 * soon as each complete `data:` frame arrives).
 */
async function emitEvent(res, event) {
  res.write(formatSse('update', event))
  await sleep(CHUNK_DELAY_MS)
}

/** Streams `chat` + `chat.title` + parts deltas + usage + closing chat. */
export function chatsCreateStream({ body }) {
  const { message, title: requestedTitle, privacy, metadata } = body
  const state = mockResponse(message)
  const { chat } = store.createChat({ message, title: requestedTitle || state.title, privacy, metadata })
  const assistant = store.addAssistant(chat.id, { parts: state.parts, content: state.text, usage: usageFor(state.text, message) })
  const steps = partsProgression(state.parts)
  const usage = usageFor(state.text, message)

  return {
    stream: async (res) => {
      res.writeHead(200, sseHeaders())
      try {
        await emitEvent(res, chatEvent(chat))
        await emitEvent(res, { object: 'chat.title', id: chat.id, delta: chat.title })
        let prev = []
        for (const step of steps) {
          await emitEvent(res, { object: 'message.parts.chunk', id: assistant.id, delta: diff(prev, step) })
          prev = step
        }
        await emitEvent(res, { object: 'message.usage', id: assistant.id, usage })
        await emitEvent(res, chatEvent(chat))
        res.end()
      } catch (err) {
        failStream(res, err)
      }
    },
  }
}

/** Streams opening message + parts deltas + usage + closing message. */
export function messagesSendStream({ params, body }) {
  const chat = store.getChat(params.chatId)
  if (!chat) return { status: 404, json: { message: 'chat_not_found' } }
  const { message } = body
  store.addMessage(chat.id, { role: 'user', content: message })
  const state = mockResponse(message)
  const assistant = store.addAssistant(chat.id, { parts: state.parts, content: state.text, usage: usageFor(state.text, message) })
  const steps = partsProgression(state.parts)
  const usage = usageFor(state.text, message)

  return {
    stream: async (res) => {
      res.writeHead(200, sseHeaders())
      try {
        await emitEvent(res, { object: 'message', ...openingMessage(assistant) })
        let prev = []
        for (const step of steps) {
          await emitEvent(res, { object: 'message.parts.chunk', id: assistant.id, delta: diff(prev, step) })
          prev = step
        }
        await emitEvent(res, { object: 'message.usage', id: assistant.id, usage })
        await emitEvent(res, { object: 'message', ...messagePayload(assistant) })
        res.end()
      } catch (err) {
        failStream(res, err)
      }
    },
  }
}

/**
 * Replays the last assistant generation as SSE. Deterministic — the mock
 * progression is rebuilt from the stored final parts, so a resumed stream
 * accumulates to the same message.
 */
export function chatsResume({ params }) {
  const chat = store.getChat(params.chatId)
  if (!chat) return { status: 404, json: { message: 'chat_not_found' } }
  const last = store.lastAssistant(chat.id)
  if (!last || !last.restorable) return { status: 204, json: null }

  const steps = partsProgression(last.parts)
  const usage = last.usage

  return {
    stream: async (res) => {
      res.writeHead(200, sseHeaders())
      try {
        await emitEvent(res, { object: 'message', ...openingMessage(last) })
        let prev = []
        for (const step of steps) {
          await emitEvent(res, { object: 'message.parts.chunk', id: last.id, delta: diff(prev, step) })
          prev = step
        }
        await emitEvent(res, { object: 'message.usage', id: last.id, usage })
        await emitEvent(res, { object: 'message', ...messagePayload(last) })
        res.end()
      } catch (err) {
        failStream(res, err)
      }
    },
  }
}

function failStream(res, err) {
  try {
    res.write(formatSse('update', { object: 'error', message: err.message || 'internal_error' }))
    res.end()
  } catch {
    res.destroy()
  }
}
