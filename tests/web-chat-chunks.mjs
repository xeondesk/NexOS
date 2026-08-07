// Unit tests for the dashboard stream renderer (web/chat-chunks.mjs).
// Feeds envelope update frames (the V0StreamUpdate shape the /v2/ai proxy
// emits) into V0SnapshotChunkReducer and asserts the incremental chunk stream.

import assert from 'node:assert'
import { V0SnapshotChunkReducer } from '../web/chat-chunks.mjs'

let checks = 0
function ok(name, fn) {
  checks++
  try {
    fn()
    console.log(`ok: ${name}`)
  } catch (err) {
    console.error(`FAIL: ${name}\n  ${err.message}`)
    process.exitCode = 1
  }
}

const frame = (event, parts, extra = {}) => ({ status: 'streaming', event, parts, ...extra })

ok('chat/title frames contribute no chunks before the first message', () => {
  const r = new V0SnapshotChunkReducer()
  assert.deepEqual(
    r.push(frame({ object: 'chat', id: 'chat_1' }, [])),
    [],
  )
  assert.deepEqual(
    r.push(frame({ object: 'chat.title', id: 'chat_1', delta: 'Hi' }, [])),
    [],
  )
})

ok('opening message snapshot starts the stream', () => {
  const r = new V0SnapshotChunkReducer()
  const message = { id: 'msg_1', chatId: 'chat_1', parts: [], finishReason: null }
  assert.deepEqual(
    r.push({ status: 'streaming', event: { object: 'message', ...message }, message, parts: [] }),
    [{ type: 'start', messageId: 'msg_1' }],
  )
})

ok('first parts.chunk frame (no message) seeds from event.id', () => {
  const r = new V0SnapshotChunkReducer()
  const parts = [{ type: 'thinking', text: 'Hmm', startedAt: 't', finishedAt: 't' }]
  const chunks = r.push(
    frame({ object: 'message.parts.chunk', id: 'msg_1', delta: {} }, parts, { chat: { id: 'chat_1' } }),
  )
  assert.equal(chunks[0].type, 'start')
  assert.deepEqual(chunks.slice(1), [
    { type: 'reasoning-start', id: 'msg_1:part:0' },
    { type: 'reasoning-delta', id: 'msg_1:part:0', delta: 'Hmm' },
    { type: 'reasoning-end', id: 'msg_1:part:0' },
  ])
})

ok('growing text appends only the delta', () => {
  const r = new V0SnapshotChunkReducer()
  r.push(frame({ object: 'message', id: 'msg_1' }, [], { message: { id: 'msg_1', chatId: 'c', parts: [], finishReason: null } }))
  const first = r.push(frame({ object: 'message.parts.chunk', id: 'msg_1' }, [{ type: 'text', text: 'Hello' }]))
  assert.deepEqual(first, [
    { type: 'text-start', id: 'msg_1:part:0' },
    { type: 'text-delta', id: 'msg_1:part:0', delta: 'Hello' },
  ])
  const second = r.push(frame({ object: 'message.parts.chunk', id: 'msg_1' }, [{ type: 'text', text: 'Hello world' }]))
  assert.deepEqual(second, [{ type: 'text-delta', id: 'msg_1:part:0', delta: ' world' }])
})

ok('non-append snapshot rewrites are suppressed', () => {
  const r = new V0SnapshotChunkReducer()
  r.push(frame({ object: 'message', id: 'msg_1' }, [], { message: { id: 'msg_1', chatId: 'c', parts: [], finishReason: null } }))
  r.push(frame({ object: 'message.parts.chunk', id: 'msg_1' }, [{ type: 'text', text: 'Hello world' }]))
  const shrink = r.push(frame({ object: 'message.parts.chunk', id: 'msg_1' }, [{ type: 'text', text: 'Hello wor' }]))
  assert.deepEqual(shrink, [])
})

ok('append after a finished part renders as :continuation', () => {
  const r = new V0SnapshotChunkReducer()
  r.push(frame({ object: 'message', id: 'msg_1' }, [], { message: { id: 'msg_1', chatId: 'c', parts: [], finishReason: null } }))
  r.push(frame({ object: 'message.parts.chunk', id: 'msg_1' }, [{ type: 'text', text: 'Hello', finishedAt: 't' }]))
  const cont = r.push(frame({ object: 'message.parts.chunk', id: 'msg_1' }, [{ type: 'text', text: 'Hello world', finishedAt: 't' }]))
  assert.deepEqual(cont, [
    { type: 'text-start', id: 'msg_1:part:0:continuation:1' },
    { type: 'text-delta', id: 'msg_1:part:0:continuation:1', delta: ' world' },
    { type: 'text-end', id: 'msg_1:part:0:continuation:1' },
  ])
})

ok('done frame emits finish with the finish reason', () => {
  const r = new V0SnapshotChunkReducer()
  const message = { id: 'msg_1', chatId: 'c', parts: [{ type: 'text', text: 'done', finishedAt: 't' }], finishReason: 'stop' }
  const chunks = r.push(
    { status: 'done', event: { object: 'message', ...message }, message, parts: message.parts },
    true,
  )
  const finish = chunks[chunks.length - 1]
  assert.equal(finish.type, 'finish')
  assert.equal(finish.finishReason, 'stop')
})

ok('action parts emit data-v0-<type> chunks when they change', () => {
  const r = new V0SnapshotChunkReducer()
  const message = { id: 'msg_1', chatId: 'c', parts: [], finishReason: null }
  r.push({ status: 'streaming', event: { object: 'message', ...message }, message, parts: [] })
  const bash = { type: 'bash', command: 'ls', output: '', exitCode: 0 }
  const a = r.push(frame({ object: 'message.parts.chunk', id: 'msg_1' }, [{ type: 'text', text: 'ok' }, bash]))
  const dataChunk = a.find((c) => c.type === 'data-v0-bash')
  assert.ok(dataChunk, 'data-v0-bash chunk emitted')
  assert.equal(dataChunk.id, 'msg_1:part:1')
  assert.equal(dataChunk.data.command, 'ls')
  const unchanged = r.push(frame({ object: 'message.parts.chunk', id: 'msg_1' }, [{ type: 'text', text: 'ok' }, bash]))
  assert.ok(!unchanged.some((c) => c.type === 'data-v0-bash'), 'identical part re-emits nothing')
})

ok('pushes after finish are ignored', () => {
  const r = new V0SnapshotChunkReducer()
  const message = { id: 'msg_1', chatId: 'c', parts: [{ type: 'text', text: 'done', finishedAt: 't' }], finishReason: 'stop' }
  r.push({ status: 'done', event: { object: 'message', ...message }, message, parts: message.parts }, true)
  assert.deepEqual(
    r.push(frame({ object: 'message.parts.chunk', id: 'msg_1' }, [{ type: 'text', text: 'more' }])),
    [],
  )
})

const failures = process.exitCode || 0
console.log(failures ? `web-chat-chunks: FAIL (${checks} checks)` : `web-chat-chunks: PASS (${checks} checks)`)
process.exitCode = failures
