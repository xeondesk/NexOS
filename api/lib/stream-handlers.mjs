// Streaming handlers for the v2 API gateway.
//
// Two wire formats are served from the same deterministic mock backend:
//
// Raw (`chats.createStream` / `messages.sendStream` / `chats.resume`) —
// `ChatStreamEvent` / `MessageStreamEvent` objects, each serialized as an SSE
// `data:` frame (see `formatSse` in v0-stream.mjs). The generated `createV0Client`
// folds these into accumulated snapshots via `applyStreamEvent`.
//
// Envelope (`chatsCreateStreamAI` / `messagesSendStreamAI` / `chatsResumeAI`,
// mounted at `/v2/ai/...`) — the app-side v0 format the `@v0-sdk/react`
// `V0Transport` consumes: every SSE `data:` frame is a full `V0StreamUpdate`
// `{ status, event, chat, message?, parts, usage? }` so the transport's
// snapshot chunk reducer can render without its own accumulation, and the
// stream ends with an explicit `done` frame carrying the final snapshot.
// Produced by `createV0StreamResult(...).toResponse()`.
//
// Deterministic mock backend: `mock-generator.mjs` produces final parts plus a
// parts *progression*; consecutive snapshots differ by single text appends, so
// `message.parts.chunk` deltas exercise the v0 append fast-path
// ([[idx, 'text', suffix], 9, 9]) as well as plain jsondiffpatch deltas.

import { Readable } from 'node:stream'

import { diff } from './diffpatch.mjs'
import { createV0StreamResult, formatSse } from './v0-stream.mjs'
import * as store from './chat-store.mjs'
import { mockResponse, mockResolve, partsProgression, validateTask } from './mock-generator.mjs'
import { emitWebhookEvent } from './webhooks.mjs'

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

// ---------------------------------------------------------------------------
// Event builders (shared by the raw and envelope writers)
// ---------------------------------------------------------------------------

/** Creates the chat + assistant and returns the raw event list for a chat stream. */
function chatsCreateEvents({ message, title: requestedTitle, privacy, metadata }) {
  const state = mockResponse(message)
  const { chat } = store.createChat({ message, title: requestedTitle || state.title, privacy, metadata })
  const assistant = store.addAssistant(chat.id, { parts: state.parts, content: state.text, usage: store.usageFor(state.text, message) })
  emitWebhookEvent('chat.created', store.toChatApi(chat))
  const steps = partsProgression(state.parts)
  const usage = store.usageFor(state.text, message)

  const events = [chatEvent(chat), { object: 'chat.title', id: chat.id, delta: chat.title }]
  let prev = []
  for (const step of steps) {
    events.push({ object: 'message.parts.chunk', id: assistant.id, delta: diff(prev, step) })
    prev = step
  }
  events.push({ object: 'message.usage', id: assistant.id, usage })
  events.push(chatEvent(chat))
  return { chat, assistant, events }
}

/** Builds the raw event list for a send-message stream, or a 404 result. */
function messagesSendEvents({ chatId, message }) {
  const chat = store.getChat(chatId)
  if (!chat) return { notFound: true }
  store.addMessage(chat.id, { role: 'user', content: message })
  const state = mockResponse(message)
  const assistant = store.addAssistant(chat.id, { parts: state.parts, content: state.text, usage: store.usageFor(state.text, message) })
  emitWebhookEvent('message.finished', messagePayload(assistant))
  const steps = partsProgression(state.parts)
  const usage = store.usageFor(state.text, message)

  const events = [{ object: 'message', ...openingMessage(assistant) }]
  let prev = []
  for (const step of steps) {
    events.push({ object: 'message.parts.chunk', id: assistant.id, delta: diff(prev, step) })
    prev = step
  }
  events.push({ object: 'message.usage', id: assistant.id, usage })
  events.push({ object: 'message', ...messagePayload(assistant) })
  return { chat, assistant, events }
}

/**
 * Replays the last assistant generation as events. Deterministic — the mock
 * progression is rebuilt from the stored final parts, so a resumed stream
 * accumulates to the same message.
 */
function chatsResumeEvents({ chatId }) {
  const chat = store.getChat(chatId)
  if (!chat) return { notFound: true }
  const last = store.lastAssistant(chat.id)
  if (!last || !last.restorable) return { notFound: true, empty: true }

  const steps = partsProgression(last.parts)
  const usage = last.usage

  const events = [{ object: 'message', ...openingMessage(last) }]
  let prev = []
  for (const step of steps) {
    events.push({ object: 'message.parts.chunk', id: last.id, delta: diff(prev, step) })
    prev = step
  }
  events.push({ object: 'message.usage', id: last.id, usage })
  events.push({ object: 'message', ...messagePayload(last) })
  return { chat, assistant: last, events }
}

/**
 * Builds the raw event list for a resolve-task stream (the assistant's
 * follow-up turn after the client posts its resolution), or a 404/422 result.
 */
function messagesResolveEvents({ chatId, task }) {
  const chat = store.getChat(chatId)
  if (!chat) return { notFound: true }
  const problem = validateTask(task)
  if (problem) return { invalid: problem }
  const state = mockResolve(task)
  const assistant = store.addAssistant(chat.id, { parts: state.parts, content: state.text, usage: store.usageFor(state.text, task.type) })
  emitWebhookEvent('message.finished', messagePayload(assistant))
  const steps = partsProgression(state.parts)
  const usage = store.usageFor(state.text, task.type)

  const events = [{ object: 'message', ...openingMessage(assistant) }]
  let prev = []
  for (const step of steps) {
    events.push({ object: 'message.parts.chunk', id: assistant.id, delta: diff(prev, step) })
    prev = step
  }
  events.push({ object: 'message.usage', id: assistant.id, usage })
  events.push({ object: 'message', ...messagePayload(assistant) })
  return { chat, assistant, events }
}

// ---------------------------------------------------------------------------
// Raw wire format (public /v2 contract)
// ---------------------------------------------------------------------------

/**
 * Writes one SSE `data:` frame carrying a raw stream event, then waits a tick
 * so chunk boundaries are visible to subscribers (the SDK yields events as
 * soon as each complete `data:` frame arrives).
 */
async function emitEvent(res, event) {
  res.write(formatSse('update', event))
  await sleep(CHUNK_DELAY_MS)
}

async function writeRawStream(res, events) {
  res.writeHead(200, sseHeaders())
  try {
    for (const event of events) await emitEvent(res, event)
    res.end()
  } catch (err) {
    failStream(res, err)
  }
}

/** Streams `chat` + `chat.title` + parts deltas + usage + closing chat. */
export function chatsCreateStream({ body }) {
  const { events } = chatsCreateEvents(body)
  return { stream: (res) => writeRawStream(res, events) }
}

/** Streams opening message + parts deltas + usage + closing message. */
export function messagesSendStream({ params, body }) {
  const built = messagesSendEvents({ chatId: params.chatId, message: body.message })
  if (built.notFound) return { status: 404, json: { message: 'chat_not_found' } }
  return { stream: (res) => writeRawStream(res, built.events) }
}

/** Replays the last assistant generation as a raw SSE stream. */
export function chatsResume({ params }) {
  const built = chatsResumeEvents({ chatId: params.chatId })
  if (built.notFound) return { status: 404, json: { message: 'chat_not_found' } }
  if (built.empty) return { status: 204, json: null }
  return { stream: (res) => writeRawStream(res, built.events) }
}

/** Streams the assistant's resolve-task follow-up as a raw SSE stream. */
export function messagesResolveStream({ params, body }) {
  const built = messagesResolveEvents({ chatId: params.chatId, task: body.task })
  if (built.notFound) return { status: 404, json: { message: 'chat_not_found' } }
  if (built.invalid) return { status: 422, json: { message: built.invalid } }
  return { stream: (res) => writeRawStream(res, built.events) }
}

// ---------------------------------------------------------------------------
// Envelope wire format (@v0-sdk/react V0Transport / app proxy)
// ---------------------------------------------------------------------------

function emptyError() {
  return { status: 422, json: { message: 'message is required' } }
}

async function writeEnvelopeStream(res, events) {
  res.writeHead(200, sseHeaders())
  try {
    const result = createV0StreamResult(pacedEvents(events))
    const response = result.toResponse()
    await new Promise((resolve, reject) => {
      Readable.fromWeb(response.body)
        .on('error', reject)
        .pipe(res)
        .on('finish', resolve)
        .on('error', reject)
    })
  } catch (err) {
    failStream(res, err)
  }
}

async function* pacedEvents(events) {
  for (const event of events) {
    await sleep(CHUNK_DELAY_MS)
    yield event
  }
}

/** Envelope `{status, event, chat, parts}` stream for `chats.createStream`. */
export function chatsCreateStreamAI({ body }) {
  if (!body || typeof body.message !== 'string' || body.message === '') return emptyError()
  const { events } = chatsCreateEvents(body)
  return { stream: (res) => writeEnvelopeStream(res, events) }
}

/** Envelope stream for `messages.sendStream`. */
export function messagesSendStreamAI({ params, body }) {
  if (!body || typeof body.message !== 'string' || body.message === '') return emptyError()
  const built = messagesSendEvents({ chatId: params.chatId, message: body.message })
  if (built.notFound) return { status: 404, json: { message: 'chat_not_found' } }
  return { stream: (res) => writeEnvelopeStream(res, built.events) }
}

/** Envelope stream for `chats.resume`. */
export function chatsResumeAI({ params }) {
  const built = chatsResumeEvents({ chatId: params.chatId })
  if (built.notFound) return { status: 404, json: { message: 'chat_not_found' } }
  if (built.empty) return { status: 204, json: null }
  return { stream: (res) => writeEnvelopeStream(res, built.events) }
}

function failStream(res, err) {
  try {
    res.write(formatSse('update', { object: 'error', message: err.message || 'internal_error' }))
    res.end()
  } catch {
    res.destroy()
  }
}
