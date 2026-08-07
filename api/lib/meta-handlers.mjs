// NexOS v0-compatible API gateway (Phase 3): MCP servers, webhooks, preview
// settings, and preview handling.
//
// MCP servers and webhooks are CRUD'd against persisted meta-store collections;
// `chats.getPreview` mints a signed, expiring preview URL for a chat that has
// ingested files (null while the preview is "still starting", per contract).

import * as store from './chat-store.mjs'
import { openCollection, newId } from './meta-store.mjs'
import * as webhooks from './webhooks.mjs'
import { makePreview } from './preview.mjs'

const WEBHOOK_EVENTS = [
  'chat.created',
  'chat.updated',
  'chat.deleted',
  'message.created',
  'message.updated',
  'message.deleted',
  'message.finished',
]

const PREVIEW_HOST = process.env.NEXOS_PREVIEW_HOST || '127.0.0.1'
const PREVIEW_PORT = parseInt(process.env.NEXOS_PREVIEW_PORT || '8082', 10)
const PREVIEW_SECRET = process.env.NEXOS_API_PREVIEW_SECRET || 'nexos-preview-token'

const nowIso = () => new Date().toISOString()

function mcpCollection() {
  return openCollection(store.stateDirPath(), 'mcp-servers')
}

function previewHostsCollection() {
  return openCollection(store.stateDirPath(), 'preview-hosts')
}

// ---------------------------------------------------------------------------
// MCP servers
// ---------------------------------------------------------------------------

export function mcpServersCreate({ body }) {
  const { name, url, description = '', enabled = true, auth = { type: 'none' }, scope = 'user' } = body
  const record = {
    id: newId('mcp'),
    name,
    url,
    description,
    enabled: Boolean(enabled),
    auth,
    scope,
    userId: 'local',
    createdAt: nowIso(),
    updatedAt: nowIso(),
  }
  return { status: 200, json: mcpCollection().create(record) }
}

export function mcpServersList() {
  return { status: 200, json: mcpCollection().list() }
}

export function mcpServersGet({ params }) {
  const server = mcpCollection().get(params.mcpServerId)
  if (!server) return { status: 404, json: { message: 'mcp_server_not_found' } }
  return { status: 200, json: server }
}

export function mcpServersUpdate({ params, body }) {
  const { name, url, description, enabled, auth, scope } = body
  const patch = {
    ...(name !== undefined ? { name } : {}),
    ...(url !== undefined ? { url } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(enabled !== undefined ? { enabled: Boolean(enabled) } : {}),
    ...(auth !== undefined ? { auth } : {}),
    ...(scope !== undefined ? { scope } : {}),
    updatedAt: nowIso(),
  }
  const next = mcpCollection().update(params.mcpServerId, patch)
  if (!next) return { status: 404, json: { message: 'mcp_server_not_found' } }
  return { status: 200, json: next }
}

export function mcpServersDelete({ params }) {
  if (!mcpCollection().remove(params.mcpServerId)) {
    return { status: 404, json: { message: 'mcp_server_not_found' } }
  }
  return { status: 200, json: { success: true } }
}

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

function normalizeEvents(events) {
  if (!Array.isArray(events)) return null
  if (!events.every((e) => WEBHOOK_EVENTS.includes(e))) return null
  return [...new Set(events)]
}

export function webhooksCreate({ body }) {
  const events = normalizeEvents(body.events)
  if (!events) return { status: 422, json: { message: 'events must be an array of valid webhook events' } }
  const record = {
    id: newId('hook'),
    name: String(body.name),
    events,
    url: String(body.url),
    chatId: body.chatId ?? null,
    createdAt: nowIso(),
  }
  webhooks.webhooksStore().create(record)
  return { status: 200, json: webhooks.webhookToApi(record) }
}

export function webhooksList() {
  return { status: 200, json: webhooks.webhooksStore().list().map(webhooks.webhookToApi) }
}

export function webhooksGet({ params }) {
  const hook = webhooks.webhooksStore().get(params.hookId)
  if (!hook) return { status: 404, json: { message: 'webhook_not_found' } }
  return { status: 200, json: webhooks.webhookToApi(hook) }
}

export function webhooksUpdate({ params, body }) {
  const patch = {}
  if (body.name !== undefined) patch.name = String(body.name)
  if (body.url !== undefined) patch.url = String(body.url)
  if (body.events !== undefined) {
    const events = normalizeEvents(body.events)
    if (!events) return { status: 422, json: { message: 'events must be an array of valid webhook events' } }
    patch.events = events
  }
  if (body.chatId !== undefined) patch.chatId = body.chatId
  const next = webhooks.webhooksStore().update(params.hookId, patch)
  if (!next) return { status: 404, json: { message: 'webhook_not_found' } }
  return { status: 200, json: webhooks.webhookToApi(next) }
}

export function webhooksDelete({ params }) {
  if (!webhooks.webhooksStore().remove(params.hookId)) {
    return { status: 404, json: { message: 'webhook_not_found' } }
  }
  return { status: 200, json: { id: params.hookId, deleted: true } }
}

// ---------------------------------------------------------------------------
// Preview settings (TrustedPreviewHosts)
// ---------------------------------------------------------------------------

export function settingsGetPreviewHosts() {
  const col = previewHostsCollection()
  const record = col.get('hosts') || { hosts: [] }
  return { status: 200, json: { hosts: record.hosts } }
}

export function settingsSetPreviewHosts({ body }) {
  const hosts = Array.isArray(body.hosts) ? body.hosts.slice(0, 5).map(String) : []
  const col = previewHostsCollection()
  col.create({ id: 'hosts', hosts })
  return { status: 200, json: { hosts } }
}

// ---------------------------------------------------------------------------
// Previews
// ---------------------------------------------------------------------------

export function chatsGetPreview({ params }) {
  const chat = store.getChat(params.chatId)
  if (!chat) return { status: 404, json: { message: 'chat_not_found' } }
  const files = store.getFiles(params.chatId).files || []
  if (files.length === 0) return { status: 200, json: null }
  return {
    status: 200,
    json: makePreview(params.chatId, { host: PREVIEW_HOST, port: PREVIEW_PORT, secret: PREVIEW_SECRET }),
  }
}
