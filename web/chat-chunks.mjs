// NexOS dashboard stream renderer — port of `@v0-sdk/react`'s
// `chat/chunks.ts` (Apache-2.0, https://github.com/vercel/v0-sdk).
//
// `V0SnapshotChunkReducer` reduces the accumulated v0 message snapshots that
// each envelope update frame carries (`{status, event, chat, message?, parts,
// usage}`) into incremental render chunks — the same snapshot-reducer +
// append-delta algorithm the SDK ships for streaming chat UIs:
//
//   text-start / text-delta / text-end        (for `text` parts)
//   reasoning-start / reasoning-delta / end   (for `thinking` parts)
//   data-v0-<type>                            (bash, file-edit, tool-call, ...)
//
// Emitted chunks are plain objects so the page (or tests) can render them
// without the AI SDK dependency.

export class V0SnapshotChunkReducer {
  constructor(seed) {
    this.previous = seed
    this.started = false
    this.finished = false
    this.activeText = new Map()
    this.textPartAttempts = new Map()
  }

  push(update, final = update.status === 'done') {
    const message = getMessageSnapshot(update, this.previous)
    if (!message || this.finished) return []

    const chunks = []
    if (!this.started) {
      chunks.push({ type: 'start', messageId: message.id })
      this.started = true
    }

    message.parts.forEach((part, index) => {
      const previousPart = this.previous?.parts[index]
      switch (part.type) {
        case 'text':
        case 'thinking':
          chunks.push(...this.updateTextPart(message, part, previousPart, index))
          break
        default: {
          const data = serializePartData(part)
          if (
            previousPart?.type !== part.type ||
            JSON.stringify(data) !== JSON.stringify(serializePartData(previousPart))
          ) {
            chunks.push({ type: `data-v0-${part.type}`, id: getV0PartId(message.id, index), data })
          }
        }
      }
    })

    this.previous = message

    if (final) {
      for (const { id, type } of this.activeText.values()) {
        chunks.push({ type: type === 'text' ? 'text-end' : 'reasoning-end', id })
      }
      this.activeText.clear()
      chunks.push({
        type: 'finish',
        ...(message.finishReason ? { finishReason: message.finishReason } : {}),
      })
      this.finished = true
    }

    return chunks
  }

  updateTextPart(message, part, previousPart, index) {
    const chunks = []
    const previousText = previousPart?.type === part.type ? previousPart.text : ''
    // Text chunks are append-only, so non-append snapshot rewrites cannot be
    // represented without corrupting the already-rendered text.
    const delta = part.text.startsWith(previousText) ? part.text.slice(previousText.length) : ''
    let active = this.activeText.get(index)

    if (active && active.type !== part.type) {
      chunks.push({ type: active.type === 'text' ? 'text-end' : 'reasoning-end', id: active.id })
      this.activeText.delete(index)
      active = undefined
    }

    if ((!previousPart || delta) && !active) {
      const attempt = this.textPartAttempts.get(index) ?? 0
      const suffix =
        attempt === 0
          ? previousPart?.type === part.type
            ? ':continuation'
            : ''
          : `:continuation:${attempt}`
      const id = `${getV0PartId(message.id, index)}${suffix}`
      this.textPartAttempts.set(index, attempt + 1)
      active = { id, type: part.type }
      this.activeText.set(index, active)
      chunks.push({ type: part.type === 'text' ? 'text-start' : 'reasoning-start', id })
    }

    if (delta && active) {
      chunks.push({
        type: part.type === 'text' ? 'text-delta' : 'reasoning-delta',
        id: active.id,
        delta,
      })
    }

    if (active && part.finishedAt) {
      chunks.push({ type: part.type === 'text' ? 'text-end' : 'reasoning-end', id: active.id })
      this.activeText.delete(index)
    }

    return chunks
  }
}

/** Extracts the message snapshot a frame contributes (mirrors chunks.ts). */
function getMessageSnapshot(update, previous) {
  if (update.message) {
    return {
      id: update.message.id,
      chatId: update.message.chatId,
      parts: update.parts,
      finishReason: update.message.finishReason,
    }
  }

  if (
    !previous &&
    update.chat &&
    (update.event.object === 'message.parts.chunk' || update.event.object === 'message.usage')
  ) {
    return {
      id: update.event.id,
      chatId: update.chat.id,
      parts: update.parts,
      finishReason: null,
    }
  }

  if (previous && update.status === 'done') {
    return { ...previous, parts: update.parts }
  }

  if (
    previous &&
    (update.event.object === 'message.parts.chunk' || update.event.object === 'message.usage')
  ) {
    return { ...previous, parts: update.parts }
  }

  return undefined
}

function serializePartData(part) {
  if (!part) return undefined
  const { type, ...data } = part
  return data
}

function getV0PartId(messageId, index) {
  return `${messageId}:part:${index}`
}
