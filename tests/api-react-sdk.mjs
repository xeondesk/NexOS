// @v0-sdk/react V0Transport round-trip test against a live NexOS API gateway.
//
// Uses the production `@v0-sdk/react` transport exactly as the AI SDK `useChat`
// hook would: first turn POSTs to `urls.create`, the gateway's stream events
// carry `chat` + accumulated `parts`, and the transport's snapshot chunk
// reducer yields AI SDK `UIMessageChunk`s (start / text-delta / finish). Also
// exercises `sendMessages` (send URL) and `reconnectToStream` (resume URL).
//
// This proves the gateway's SSE wire format is compatible with the
// `readV0Stream` + `V0SnapshotChunkReducer` pipeline the transport uses.
//
// Run against a booted server:
//   NEXOS_STREAM_BASE=http://127.0.0.1:9986/v2 node tests/api-react-sdk.mjs

import assert from 'node:assert/strict'
import { V0Transport } from '@v0-sdk/react'

const baseUrl = process.env.NEXOS_STREAM_BASE || 'http://127.0.0.1:9986/v2'

let checks = 0
async function check(name, fn) {
  checks++
  try {
    await fn()
    console.log(`ok: ${name}`)
  } catch (err) {
    console.error(`FAIL: ${name}\n  ${err.message}`)
    process.exitCode = 1
  }
}

const MOCK_TEXT =
  "I've built the project in your workspace.\n\nHere's what I created:\n\n" +
  '- `index.html` — entry point\n' +
  '- `app.js` — client logic\n' +
  '- `styles.css` — styling\n\n' +
  'Open the preview to see it running.'

function userMessage(text) {
  return { id: 'local_user', role: 'user', parts: [{ type: 'text', text }] }
}

function sendOptions(messages) {
  return {
    trigger: 'submit-message',
    chatId: 'local_chat',
    messageId: undefined,
    messages,
    abortSignal: undefined,
  }
}

function urls(base) {
  return {
    create: `${base}/ai/chats/stream`,
    send: (chatId) => `${base}/ai/chats/${chatId}/messages/stream`,
    resume: (chatId) => `${base}/ai/chats/${chatId}/resume`,
  }
}

async function collect(stream) {
  const chunks = []
  const reader = stream.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
  }
  return chunks
}

const textDeltas = (chunks) =>
  chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.delta).join('')

// --- create: first turn discovers the chat id ------------------------------
const createdChatIds = []
const transport = new V0Transport({
  urls: urls(baseUrl),
  onChatCreated: (chatId) => createdChatIds.push(chatId),
})

let chunks
await check('sendMessages.create yields UIMessageChunks', async () => {
  const stream = await transport.sendMessages(sendOptions([userMessage('build me a landing page')]))
  chunks = await collect(stream)
  assert.ok(Array.isArray(chunks) && chunks.length > 0)
})
await check('onChatCreated fires once with a chat id', () => {
  assert.equal(createdChatIds.length, 1)
  assert.match(createdChatIds[0], /^chat_/)
})
await check('transport.chatId matches the created chat', () => {
  assert.equal(transport.chatId, createdChatIds[0])
})
await check('stream opens with a start chunk', () => {
  assert.ok(chunks.some((chunk) => chunk.type === 'start'), 'missing start chunk')
})
await check('text-delta chunks accumulate to the full assistant text', () => {
  assert.equal(textDeltas(chunks), MOCK_TEXT)
})
await check('create stream closes with a finish chunk', () => {
  assert.ok(chunks.some((chunk) => chunk.type === 'finish'), 'missing finish chunk')
})

// --- send: second turn reuses the chat id -----------------------------------
let sendChunks
await check('sendMessages.send completes a second turn', async () => {
  const stream = await transport.sendMessages(sendOptions([userMessage('add a footer')]))
  sendChunks = await collect(stream)
  assert.ok(sendChunks.length > 0)
})
await check('second turn keeps the same chat id', () => {
  assert.equal(transport.chatId, createdChatIds[0])
})
await check('second turn streams the full assistant text', () => {
  assert.equal(textDeltas(sendChunks), MOCK_TEXT)
})
await check('second turn closes with finishReason stop', () => {
  const finish = sendChunks.find((chunk) => chunk.type === 'finish')
  assert.ok(finish, 'missing finish chunk')
  assert.equal(finish.finishReason, 'stop')
})

// --- resume: replay via reconnectToStream -----------------------------------
// `reconnectToStream` needs the unfinished assistant message in history as its
// seed (that's how `useChat` reconnects) — it returns null without one.
let resumeChunks
await check('reconnectToStream returns a live stream', async () => {
  const start = sendChunks.find((chunk) => chunk.type === 'start')
  const seed = {
    id: start.messageId,
    chatId: createdChatIds[0],
    role: 'assistant',
    content: '',
    parts: [],
    finishReason: null,
  }
  const resumed = new V0Transport({ urls: urls(baseUrl), messages: [seed] })
  const stream = await resumed.reconnectToStream({ chatId: createdChatIds[0] })
  assert.ok(stream, 'expected a stream, got null/204')
  resumeChunks = await collect(stream)
  assert.ok(resumeChunks.length > 0)
})
await check('resume replays the full assistant text', () => {
  assert.equal(textDeltas(resumeChunks), MOCK_TEXT)
})
await check('resume closes with finishReason stop', () => {
  const finish = resumeChunks.find((chunk) => chunk.type === 'finish')
  assert.ok(finish, 'missing finish chunk')
  assert.equal(finish.finishReason, 'stop')
})

const failures = process.exitCode || 0
console.log(
  failures ? `api-react-sdk: FAIL (${checks} checks)` : `api-react-sdk: PASS (${checks} checks)`,
)
