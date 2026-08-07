// Unit tests for the Phase 1 streaming libs (no server required):
//   - diffpatch.mjs: diff/patch round-trip incl. the v0 append fast-path
//   - mock-generator.mjs: append-only parts progression
//   - v0-stream.mjs: applyStreamEvent accumulation + format-2 round-trip
//     (createV0StreamResult -> toResponse -> readV0Stream)
// Run: node tests/api-stream-unit.mjs

import assert from 'node:assert/strict'
import { diff, patch } from '../api/lib/diffpatch.mjs'
import { mockResponse, partsProgression } from '../api/lib/mock-generator.mjs'
import { createV0StreamResult, readV0Stream, applyStreamEvent } from '../api/lib/v0-stream.mjs'

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

// --- diffpatch -----------------------------------------------------------

check('string diff/patch round-trip', () => {
  const a = 'hello world, this is a fairly long sentence to make the diff meaningful'
  const b = `${a} and then some more appended tail text`
  assert.equal(patch(a, diff(a, b)), b)
})

check('object diff/patch round-trip', () => {
  const a = { id: 'm', parts: [{ type: 'text', text: 'abc', startedAt: 't1' }], done: false }
  const b = { id: 'm', parts: [{ type: 'text', text: 'abcdef', startedAt: 't1' }, { type: 'file-edit', path: 'x' }], done: true }
  assert.deepEqual(patch(JSON.parse(JSON.stringify(a)), diff(a, b)), b)
})

check('v0 append fast-path fires for string arrays', () => {
  assert.deepEqual(diff(['a'], ['ab']), [[0, 'b'], 9, 9])
  assert.deepEqual(diff(['ab'], ['ab', 'cd']), { _t: 'a', 1: ['cd'] })
})

check('v0 append fast-path patches', () => {
  assert.deepEqual(patch(['a'], [[0, 'b'], 9, 9]), ['ab'])
  assert.deepEqual(patch(['a', 'b'], [[1, 'c'], 9, 9]), ['a', 'bc'])
})

check('empty delta is a no-op', () => {
  const x = { a: [1, 2] }
  assert.equal(patch(x, undefined), x)
})

// --- mock-generator ------------------------------------------------------

check('progression is append-only and ends at the final parts', () => {
  const state = mockResponse('build me a landing page')
  const steps = partsProgression(state.parts)
  assert.ok(steps.length >= 3)
  let acc = []
  for (const step of steps) {
    assert.deepEqual(patch(acc, diff(acc, step)), step)
    acc = step
  }
  assert.deepEqual(acc, state.parts)
})

check('progression is append-only (text parts only grow)', () => {
  const state = mockResponse('landing page')
  const steps = partsProgression(state.parts)
  for (let s = 0; s + 1 < steps.length; s++) {
    const cur = steps[s]
    const next = steps[s + 1]
    assert.ok(cur.length <= next.length, `step ${s} must not shrink parts`)
    cur.forEach((part, i) => {
      if (part.type === 'text' || part.type === 'thinking') {
        assert.ok(
          next[i]?.text?.startsWith(part.text),
          `step ${s} part ${i} text must be a prefix of step ${s + 1}`,
        )
      } else {
        assert.deepEqual(next[i], part, `step ${s} part ${i} static part must be preserved`)
      }
    })
  }
})

// --- applyStreamEvent (wire-format fold, mirrors the SDK) ----------------

check('applyStreamEvent accumulates chat + title + parts + usage', () => {
  const state = mockResponse('hello')
  const steps = partsProgression(state.parts)
  let update
  update = applyStreamEvent(update, { object: 'chat', id: 'chat_1', title: '', privacy: 'private', createdAt: 't', updatedAt: 't', authorId: 'u', metadata: {}, writePermission: true })
  update = applyStreamEvent(update, { object: 'chat.title', id: 'chat_1', delta: 'Hello' })
  for (const step of steps) {
    update = applyStreamEvent(update, { object: 'message.parts.chunk', id: 'msg_1', delta: diff(update.parts, step) })
  }
  const usage = { tokens: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3 } }
  update = applyStreamEvent(update, { object: 'message.usage', id: 'msg_1', usage })
  assert.equal(update.chat.id, 'chat_1')
  assert.equal(update.title, 'Hello')
  assert.deepEqual(update.parts, state.parts)
  assert.deepEqual(update.usage, usage)
})

check('applyStreamEvent surfaces error events', () => {
  assert.throws(
    () => applyStreamEvent(undefined, { object: 'error', message: 'boom', code: 'rate_limited' }),
    (err) => err.name === 'V0StreamError' && err.code === 'rate_limited',
  )
})

// --- format-2 round-trip (toResponse -> readV0Stream) --------------------

check('createV0StreamResult -> toResponse -> readV0Stream round-trip', async () => {
  const state = mockResponse('round trip')
  const steps = partsProgression(state.parts)
  async function* events() {
    yield { object: 'chat', id: 'chat_1', title: '', privacy: 'private', createdAt: 't', updatedAt: 't', authorId: 'u', metadata: {}, writePermission: true }
    yield { object: 'chat.title', id: 'chat_1', delta: 'Round trip' }
    let prev = []
    for (const step of steps) {
      yield { object: 'message.parts.chunk', id: 'msg_1', delta: diff(prev, step) }
      prev = step
    }
    yield { object: 'message.usage', id: 'msg_1', usage: { tokens: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3 } } }
  }

  const result = createV0StreamResult(events())
  const response = result.toResponse({ headers: { 'x-custom': 'yes' } })
  assert.equal(response.headers.get('Content-Type'), 'text/event-stream; charset=utf-8')
  assert.equal(response.headers.get('x-custom'), 'yes')

  const read = readV0Stream(response)
  let updates = 0
  for await (const update of read.stream) {
    updates++
    assert.equal(update.status, 'streaming')
  }
  const final = await read.final
  assert.ok(updates >= 3)
  assert.equal(final.status, 'done')
  assert.equal(final.chat.id, 'chat_1')
  assert.equal(final.title, 'Round trip')
  assert.deepEqual(final.parts, state.parts)
})

check('readV0Stream yields multiple consumers the same history', async () => {
  async function* events() {
    yield { object: 'chat', id: 'c', title: '', privacy: 'private' }
  }
  const result = createV0StreamResult(events())
  const read1 = readV0Stream(result.toResponse())
  const read2 = readV0Stream(result.toResponse())
  const f1 = []
  const f2 = []
  for await (const u of read1.stream) f1.push(u)
  for await (const u of read2.stream) f2.push(u)
  assert.equal((await read1.final).chat.id, 'c')
  assert.equal(f1.length, f2.length)
})

const failures = process.exitCode || 0
console.log(failures ? `api-stream-unit: FAIL (${checks} checks)` : `api-stream-unit: PASS (${checks} checks)`)
