// NexOS v0-compatible API gateway (Phase 3): webhook delivery loop.
//
// Webhook records are persisted via meta-store (`webhooks` collection, Webhook
// schema). `emitWebhookEvent` fans an in-process lifecycle event out to every
// subscribed (and chat-scoped) webhook with a fire-and-forget delivery: POST
// `{ event, createdAt, data }` to the hook URL, up to MAX_ATTEMPTS retries with
// exponential backoff, and every attempt + outcome is appended to
// `webhook-deliveries.jsonl` (used by tests and for observability).

import { openCollection, appendLine, readLines, newId } from './meta-store.mjs'

const MAX_ATTEMPTS = 3
const BACKOFF_MS = [300, 800, 1600]
const TIMEOUT_MS = 10_000

let collection = null
let logDir = null
let fetchImpl = globalThis.fetch
let deliveries = 0

export function initWebhooks({ dir, fetch: fetchFn } = {}) {
  logDir = dir
  if (fetchFn) fetchImpl = fetchFn
  collection = openCollection(dir, 'webhooks')
  return collection
}

/** The open webhooks collection (initialized by initWebhooks). */
export function webhooksStore() {
  if (!collection) throw new Error('webhooks store not initialized')
  return collection
}

/** Webhook schema projection: { id, name, events, url, chatId, createdAt }. */
export function webhookToApi(hook) {
  const { id, name, events, url, chatId, createdAt } = hook
  return { id, name, events, url, chatId: chatId ?? null, createdAt }
}

/** Total deliveries attempted (for tests). */
export function deliveryCount() {
  return deliveries
}

/** Reads back the persisted delivery log (newest first). */
export function listDeliveries({ limit = 100 } = {}) {
  const lines = readLines(logDir, 'webhook-deliveries')
  return lines.reverse().slice(0, limit)
}

/**
 * Fires an event at every matching webhook. Returns immediately (fire and
 * forget); deliveries run with retries and are logged to disk.
 */
export function emitWebhookEvent(event, data) {
  if (!collection) return
  const scope = data && (data.chatId || data.id)
  const hooks = collection
    .list()
    .filter(
      (hook) =>
        Array.isArray(hook.events) &&
        hook.events.includes(event) &&
        (!hook.chatId || hook.chatId === scope)
    )
  for (const hook of hooks) {
    scheduleDelivery(hook, event, data, 0)
  }
}

function scheduleDelivery(hook, event, data, attempt) {
  const deliveryId = newId('delivery')
  const at = new Date().toISOString()
  deliveries += 1
  record({ deliveryId, webhookId: hook.id, event, attempt: attempt + 1, at, state: 'sending' })
  const delay = attempt === 0 ? 0 : BACKOFF_MS[Math.min(attempt - 1, BACKOFF_MS.length - 1)]
  const timer = setTimeout(() => runDelivery(hook, event, data, attempt, deliveryId), delay)
  if (typeof timer.unref === 'function') timer.unref()
}

async function runDelivery(hook, event, data, attempt, deliveryId) {
  const payload = {
    id: deliveryId,
    event,
    createdAt: new Date().toISOString(),
    data,
  }
  let status = 0
  let error = null
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS)
    const res = await fetchImpl(hook.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-nexos-webhook-delivery': deliveryId,
        'x-nexos-webhook-event': event,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })
    clearTimeout(timeout)
    status = res.status
    if (status < 200 || status >= 300) throw new Error(`http_${status}`)
    record({ deliveryId, webhookId: hook.id, event, attempt: attempt + 1, at: new Date().toISOString(), state: 'delivered', status })
  } catch (err) {
    error = err
    if (attempt + 1 < MAX_ATTEMPTS) {
      record({ deliveryId, webhookId: hook.id, event, attempt: attempt + 1, at: new Date().toISOString(), state: 'retrying', status, error: String(error.message || error) })
      scheduleDelivery(hook, event, data, attempt + 1)
      return
    }
    record({ deliveryId, webhookId: hook.id, event, attempt: attempt + 1, at: new Date().toISOString(), state: 'failed', status, error: String(error.message || error) })
  }
}

function record(entry) {
  if (!logDir) return
  appendLine(logDir, 'webhook-deliveries', entry)
}
