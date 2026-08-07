// v0 streaming result — ported from vercel/v0-sdk `stream/result.ts`
// (Apache-2.0, https://github.com/vercel/v0-sdk).
//
// Two wire formats exist:
//   1. The api.v0.dev/v2 wire: raw stream-event objects discriminated by
//      `object` (`chat`, `chat.title`, `message`, `message.parts.chunk`,
//      `message.usage`, `error`). The generated SDK client parses these and
//      folds them into accumulated snapshots with `applyStreamEvent`.
//   2. `V0StreamResult.toResponse()`: the accumulated `V0StreamUpdate` snapshots
//      re-serialized as `event: update` / `event: done` SSE (used by
//      application proxy routes; `readV0Stream` parses this back).
//
// The NexOS API gateway emits format 1 on /v2/chats/stream etc.; both formats
// are implemented here so the wire round-trip is unit-testable without the SDK.

import { patch } from './diffpatch.mjs'

export class V0StreamError extends Error {
  constructor(message, options = {}) {
    super(message)
    this.name = 'V0StreamError'
    this.code = options.code
    this.id = options.id
  }
}

/** @internal Folds a raw stream event into the accumulated snapshot. */
export function applyStreamEvent(state, event) {
  const next = state ?? { status: 'streaming', event, parts: [] }

  switch (event.object) {
    case 'chat': {
      return { ...next, event, chat: stripObject(event) }
    }
    case 'chat.title': {
      return applyTitle({ ...next, event }, event.delta)
    }
    case 'message': {
      const message = stripObject(event)
      return { ...next, event, message, parts: message.parts, usage: message.usage }
    }
    case 'message.parts.chunk': {
      return applyPartsDelta({ ...next, event }, event.delta)
    }
    case 'message.usage': {
      return applyUsage({ ...next, event }, event.usage)
    }
    case 'error': {
      throw new V0StreamError(event.message, { code: event.code, id: event.id })
    }
    default: {
      const raw = event
      throw new V0StreamError(
        typeof raw.message === 'string' ? raw.message : 'v0 stream failed',
        { code: typeof raw.code === 'string' ? raw.code : undefined, id: raw.id },
      )
    }
  }
}

function applyTitle(update, title) {
  return {
    ...update,
    title,
    chat: update.chat ? { ...update.chat, title } : update.chat,
  }
}

function applyPartsDelta(update, delta) {
  const parts = patch(update.parts, delta)
  return {
    ...update,
    parts,
    message: update.message ? { ...update.message, parts } : update.message,
  }
}

function applyUsage(update, usage) {
  return {
    ...update,
    usage,
    message: update.message ? { ...update.message, usage } : update.message,
  }
}

function stripObject(value) {
  const { object: _object, ...rest } = value
  return rest
}

function toFinal(update) {
  return { ...update, status: 'done' }
}

/** Builds a {@link V0StreamResult} from a raw-event async iterable. */
export function createV0StreamResult(events) {
  return new SharedV0StreamResult(async (emit, finish) => {
    let state
    for await (const event of events) {
      state = applyStreamEvent(state, event)
      emit(state)
    }
    if (!state) throw new V0StreamError('v0 stream ended before sending an event')
    finish(toFinal(state))
  })
}

/**
 * Reconstructs a {@link V0StreamResult} from an SSE {@link Response} produced
 * by {@link V0StreamResult.toResponse}.
 */
export function readV0Stream(response) {
  return new SharedV0StreamResult(async (emit, finish) => {
    let latest
    for await (const event of parseV0StreamResponse(await response)) {
      if (event.event === 'update') {
        latest = event.data
        emit(event.data)
        continue
      }
      if (event.event === 'done') {
        finish(event.data)
        return
      }
      throw new V0StreamError(
        typeof event.data.message === 'string' ? event.data.message : 'v0 stream failed',
        { code: typeof event.data.code === 'string' ? event.data.code : undefined, id: event.data.id },
      )
    }
    if (!latest) throw new V0StreamError('v0 stream ended before sending an event')
    finish(toFinal(latest))
  })
}

class SharedV0StreamResult {
  constructor(run) {
    this.history = []
    this.subscribers = new Set()
    this.started = false
    this.finished = false
    this.failure = undefined
    this.run = run
    this.finalPromise = new Promise((resolve, reject) => {
      this.resolveFinal = resolve
      this.rejectFinal = reject
    })
    this.finalPromise.catch(() => {})
    this.stream = { [Symbol.asyncIterator]: () => this.subscribe() }
  }

  get final() {
    this.start()
    return this.finalPromise
  }

  toResponse(init = {}) {
    const encoder = new TextEncoder()
    const result = this

    const stream = new ReadableStream({
      async start(controller) {
        try {
          for await (const update of result.stream) {
            controller.enqueue(encoder.encode(formatSse('update', update)))
          }
          controller.enqueue(encoder.encode(formatSse('done', await result.final)))
        } catch (error) {
          controller.enqueue(encoder.encode(formatSse('error', serializeError(error))))
        } finally {
          controller.close()
        }
      },
    })

    const headers = new Headers(init.headers)
    if (!headers.has('Content-Type')) headers.set('Content-Type', 'text/event-stream; charset=utf-8')
    if (!headers.has('Cache-Control')) headers.set('Cache-Control', 'no-cache, no-transform')
    if (!headers.has('Connection')) headers.set('Connection', 'keep-alive')
    if (!headers.has('X-Accel-Buffering')) headers.set('X-Accel-Buffering', 'no')

    return new Response(stream, { ...init, headers })
  }

  async *subscribe() {
    const subscriber = { queue: [...this.history], notify: undefined }
    this.subscribers.add(subscriber)
    this.start()

    try {
      while (true) {
        if (subscriber.queue.length > 0) {
          yield subscriber.queue.shift()
          continue
        }
        if (this.failure) throw this.failure
        if (this.finished) return
        await new Promise((resolve) => {
          subscriber.notify = resolve
        })
        subscriber.notify = undefined
      }
    } finally {
      this.subscribers.delete(subscriber)
    }
  }

  start() {
    if (this.started) return
    this.started = true
    this.run(
      (event) => this.publish(event),
      (event) => this.finish(event),
    ).catch((error) => this.fail(error))
  }

  publish(update) {
    this.history.push(update)
    for (const subscriber of this.subscribers) {
      subscriber.queue.push(update)
      subscriber.notify?.()
    }
  }

  finish(final) {
    if (this.finished) return
    this.finished = true
    this.resolveFinal(final)
    this.notifySubscribers()
  }

  fail(error) {
    if (this.finished) return
    this.finished = true
    this.failure = error
    this.rejectFinal(error)
    this.notifySubscribers()
  }

  notifySubscribers() {
    for (const subscriber of this.subscribers) subscriber.notify?.()
  }
}

export function formatSse(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

export async function* parseV0StreamResponse(response) {
  if (!response.ok) {
    throw new V0StreamError(`v0 stream request failed: ${response.status} ${response.statusText}`)
  }
  if (!response.body) throw new V0StreamError('v0 stream response did not include a body')

  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += value
      buffer = buffer.replace(/\r\n/g, '\n').replace(/\r/g, '\n')

      const chunks = buffer.split('\n\n')
      buffer = chunks.pop() ?? ''

      for (const chunk of chunks) {
        const event = parseWireEvent(chunk)
        if (event) yield event
      }
    }

    const remaining = buffer.trim()
    if (remaining) {
      const event = parseWireEvent(remaining)
      if (event) yield event
    }
  } finally {
    reader.releaseLock()
  }
}

function parseWireEvent(rawEvent) {
  let eventName = 'message'
  const dataLines = []

  for (const line of rawEvent.split('\n')) {
    if (line.startsWith('event:')) {
      eventName = line.replace(/^event:\s*/, '')
      continue
    }
    if (line.startsWith('data:')) {
      dataLines.push(line.replace(/^data:\s*/, ''))
    }
  }

  if (dataLines.length === 0) return null

  let data
  try {
    data = JSON.parse(dataLines.join('\n'))
  } catch {
    return null
  }

  if ((eventName === 'update' || eventName === 'message') && isJsonObject(data)) {
    return { event: 'update', data }
  }
  if (eventName === 'done' && isJsonObject(data)) {
    return { event: 'done', data }
  }
  if (eventName === 'error' && isJsonObject(data)) {
    return { event: 'error', data }
  }
  return null
}

function isJsonObject(value) {
  return typeof value === 'object' && value !== null
}

function serializeError(error) {
  if (error instanceof V0StreamError) {
    return { message: error.message, code: error.code, id: error.id }
  }
  if (error instanceof Error) return { message: error.message }
  return { message: 'v0 stream failed' }
}
