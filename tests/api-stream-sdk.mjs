// Real-SDK round-trip test against a live NexOS API gateway.
//
// Uses the actual `v0` npm package (v3.0.3, devDependency) exactly as an app
// would: createV0Client({ baseUrl }) -> chats.createStream / messages.sendStream
// / chats.resume -> V0StreamResult.stream (accumulated snapshots) + .final.
// This proves the gateway's SSE wire format is byte-compatible with what the
// production SDK parses.
//
// Run against a booted server:
//   NEXOS_STREAM_BASE=http://127.0.0.1:9986/v2 NEXOS_STREAM_TOKEN=... node tests/api-stream-sdk.mjs

import assert from 'node:assert/strict'
import { createV0Client } from 'v0'

const baseUrl = process.env.NEXOS_STREAM_BASE || 'http://127.0.0.1:9986/v2'
const token = process.env.NEXOS_STREAM_TOKEN || ''

let checks = 0
function check(name, fn) {
  checks++
  try {
    fn()
    console.log(`ok: ${name}`)
  } catch (err) {
    console.error(`FAIL: ${name}\n  ${err.message}`)
    process.exitCode = 1
  }
}

const client = createV0Client({ baseUrl, auth: token || undefined })

async function collect(result) {
  const updates = []
  for await (const update of result.stream) updates.push(update)
  const final = await result.final
  return { updates, final }
}

check('createStream yields chat, title, growing parts, done status', async () => {
  const result = await client.chats.createStream({ message: 'build me a landing page' })
  const { updates, final } = await collect(result)

  assert.ok(updates.length >= 3, `expected >=3 updates, got ${updates.length}`)
  assert.equal(final.status, 'done')
  assert.match(final.chat.id, /^chat_/)
  assert.ok(final.title.length > 0)
  assert.ok(final.chat.privacy, 'chat has privacy')

  const textParts = final.parts.filter((p) => p.type === 'text' || p.type === 'thinking')
  assert.ok(textParts.length >= 2, 'expected thinking + text parts')
  assert.ok(textParts.some((p) => p.text.length > 0), 'text content streamed')

  // parts only grow as we go (append-only text)
  let previousTextLength = -1
  for (const update of updates) {
    const len = update.parts.reduce((n, p) => n + (p.text?.length || 0), 0)
    assert.ok(len >= previousTextLength, 'parts must only grow')
    previousTextLength = len
  }
})

check('createStream uses the requested title when provided', async () => {
  const result = await client.chats.createStream({ message: 'hi', title: 'My custom title' })
  const { final } = await collect(result)
  assert.equal(final.title, 'My custom title')
})

check('sendStream yields a complete assistant message', async () => {
  const created = await client.chats.createStream({ message: 'seed' })
  const { final: createdFinal } = await collect(created)
  const chatId = createdFinal.chat.id

  const result = await client.messages.sendStream({ chatId, message: 'add a pricing section' })
  const { updates, final } = await collect(result)

  assert.equal(final.status, 'done')
  assert.equal(final.message.role, 'assistant')
  assert.equal(final.message.chatId, chatId)
  assert.match(final.message.id, /^msg_/)
  assert.equal(final.message.finishReason, 'stop')
  assert.equal(final.message.restorable, true)

  const text = final.parts
    .filter((p) => p.type === 'text')
    .map((p) => p.text)
    .join('')
  assert.ok(text.length > 0, 'assistant produced text')

  // initial message snapshot had empty parts, grew via chunk deltas
  assert.ok(updates.some((u) => u.message && u.message.parts.length === 0), 'opening snapshot streamed')
  assert.ok(updates.some((u) => u.usage && u.usage.tokens.total > 0), 'usage streamed')
})

check('resume replays the last assistant generation deterministically', async () => {
  const created = await client.chats.createStream({ message: 'resume me' })
  const { final: createdFinal } = await collect(created)
  const chatId = createdFinal.chat.id

  const sent = await client.messages.sendStream({ chatId, message: 'another turn' })
  const { final: sentFinal } = await collect(sent)

  const resumed = await client.chats.resume({ chatId })
  const { final: resumedFinal } = await collect(resumed)

  assert.deepEqual(resumedFinal.parts, sentFinal.parts, 'resumed stream accumulates to same parts')
})

const failures = process.exitCode || 0
console.log(failures ? `api-stream-sdk: FAIL (${checks} checks)` : `api-stream-sdk: PASS (${checks} checks)`)
