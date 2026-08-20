// OpenAI-compatible model backend for the v2 API gateway.
//
// When `NEXOS_API_MODEL_URL` is set, the streaming ops
// (`chats.createStream`, `messages.sendStream` and their `/v2/ai/*` envelope
// variants) stream real assistant text from an OpenAI-compatible
// `/chat/completions` SSE endpoint instead of the deterministic mock. When it
// is unset (the default) the mock backend is used unchanged.
//
// Config:
//   NEXOS_API_MODEL_URL   base URL, e.g. https://api.openai.com/v1 (required)
//   NEXOS_API_MODEL_KEY   bearer key sent as `Authorization: Bearer <key>`
//   NEXOS_API_MODEL       model name (default "gpt-4o-mini")

const DEFAULT_MODEL = 'gpt-4o-mini'

export function modelConfig() {
  return {
    baseUrl: process.env.NEXOS_API_MODEL_URL || '',
    apiKey: process.env.NEXOS_API_MODEL_KEY || '',
    model: process.env.NEXOS_API_MODEL || DEFAULT_MODEL,
  }
}

/** True when a real model backend is configured (mock is the default). */
export function isModelEnabled() {
  return Boolean(modelConfig().baseUrl)
}

export function normalizeBaseUrl(baseUrl) {
  return String(baseUrl || '').replace(/\/+$/, '')
}

/**
 * Streams an assistant turn from the configured model. Yields incremental
 * deltas of the form `{ type: 'text', text }` (or `{ type: 'thinking', text }`
 * when the provider surfaces reasoning content). Throws on transport errors,
 * non-2xx responses, or an empty body.
 */
export async function* streamModelDeltas({ prompt, history = [] }) {
  const { baseUrl, apiKey, model } = modelConfig()
  if (!baseUrl) throw new Error('model backend is not configured')

  const url = `${normalizeBaseUrl(baseUrl)}/chat/completions`
  const messages = [...history, { role: 'user', content: String(prompt || '') }]

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({ model, messages, stream: true }),
  })

  if (!response.ok) {
    let detail = ''
    try {
      detail = (await response.text()).trim()
    } catch {
      // ignore body read failures; the status line carries the error
    }
    throw new Error(`model request failed: ${response.status} ${detail}`.trim())
  }
  if (!response.body) throw new Error('model request returned no body')

  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += value

      const chunks = buffer.split('\n\n')
      buffer = chunks.pop() ?? ''

      for (const chunk of chunks) {
        for (const line of chunk.split('\n')) {
          if (!line.startsWith('data:')) continue
          const payload = line.replace(/^data:\s*/, '').trim()
          if (!payload || payload === '[DONE]') continue
          let json
          try {
            json = JSON.parse(payload)
          } catch {
            continue
          }
          const choice = json.choices?.[0]
          if (!choice?.delta) continue
          if (choice.delta.reasoning_content) {
            yield { type: 'thinking', text: choice.delta.reasoning_content }
          }
          if (choice.delta.content) {
            yield { type: 'text', text: choice.delta.content }
          }
        }
      }
    }
  } finally {
    reader.releaseLock()
  }
}