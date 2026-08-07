// Deterministic mock assistant output for the streaming backend.
// Produces a final message { title, parts } plus a parts *progression* whose
// successive snapshots differ by single text appends — this is what lets the
// gateway emit `message.parts.chunk` deltas (including the v0 append
// fast-path [[idx, 'text', suffix], 9, 9]) during a chat/message stream.

import { newId } from './chat-store.mjs'

export function titleFromPrompt(prompt) {
  const clean = String(prompt || '').trim().replace(/\s+/g, ' ')
  if (!clean) return 'New chat'
  const short = clean.length > 50 ? `${clean.slice(0, 47)}...` : clean
  return short.charAt(0).toUpperCase() + short.slice(1)
}

export function mockResponse(prompt) {
  const ts = new Date().toISOString()
  const promptText = String(prompt || '').trim()
  const thinking =
    promptText.length > 0
      ? `I'll scaffold a small static site for: "${promptText}". I'll keep it self-contained, dependency-free, and ready to preview.`
      : 'I\'ll scaffold a small static site. I\'ll keep it self-contained, dependency-free, and ready to preview.'
  const text =
    "I've built the project in your workspace.\n\nHere's what I created:\n\n" +
    '- `index.html` — entry point\n' +
    '- `app.js` — client logic\n' +
    '- `styles.css` — styling\n\n' +
    'Open the preview to see it running.'
  const parts = [
    { type: 'thinking', text: thinking, startedAt: ts, finishedAt: ts },
    { type: 'text', text, startedAt: ts, finishedAt: ts },
    { type: 'file-edit', operation: 'add', path: 'index.html', startedAt: ts, finishedAt: ts },
    { type: 'file-edit', operation: 'add', path: 'app.js', startedAt: ts, finishedAt: ts },
  ]
  return { title: titleFromPrompt(prompt), parts, text }
}

const RESOLVE_TASK_TYPES = [
  'confirmed-steps',
  'plan-exit-response',
  'answered-questions',
  'confirmed-permissions',
  'vercel-connect-setup',
]

/**
 * Validates a resolve `task` against the v2 contract's oneOf shapes.
 * Returns an error message or null when valid.
 */
export function validateTask(task) {
  if (!task || typeof task !== 'object' || Array.isArray(task)) return 'task is required'
  const type = task.type
  if (!RESOLVE_TASK_TYPES.includes(type)) return 'invalid task type'
  if (type === 'plan-exit-response') {
    if (!['approved', 'rejected', 'request-changes'].includes(task.status)) return 'task.status is required'
    if (typeof task.content !== 'string') return 'task.content is required'
  }
  if (type === 'answered-questions' && !Array.isArray(task.answers)) return 'task.answers is required'
  if (type === 'confirmed-permissions' && !Array.isArray(task.permissions)) return 'task.permissions is required'
  return null
}

/**
 * Deterministic assistant turn for a resolved task (the message the mock
 * model emits after the client posts its resolution).
 */
export function mockResolve(task) {
  const ts = new Date().toISOString()
  let text
  switch (task.type) {
    case 'confirmed-steps': {
      const bits = []
      if ((task.connectedIntegrationNames || []).length) bits.push(`Connected: ${task.connectedIntegrationNames.join(', ')}`)
      if ((task.connectedMcpPresetNames || []).length) bits.push(`MCP presets: ${task.connectedMcpPresetNames.join(', ')}`)
      if ((task.appliedScripts || []).length) bits.push(`Applied scripts: ${task.appliedScripts.join(', ')}`)
      if ((task.addedEnvVars || []).length) bits.push(`Added env vars: ${task.addedEnvVars.join(', ')}`)
      text = 'Steps confirmed — continuing with the plan.' + (bits.length ? '\n\n' + bits.join('\n') : '')
      break
    }
    case 'plan-exit-response':
      text =
        task.status === 'approved'
          ? 'Plan approved — proceeding to implementation.'
          : task.status === 'rejected'
            ? 'Plan rejected — stopping here.'
            : `Plan changes requested: ${task.content || ''}`
      break
    case 'answered-questions':
      text = `Thanks — ${task.answers.length} answer${task.answers.length === 1 ? '' : 's'} received. Proceeding.`
      break
    case 'confirmed-permissions':
      text = `Permissions confirmed (${task.permissions.length}).${task.userMessage ? ` ${task.userMessage}` : ''}`
      break
    case 'vercel-connect-setup':
      text = 'Vercel Connect setup complete — resuming.'
      break
  }
  const parts = [
    { type: 'thinking', text: `The user resolved the "${task.type}" task.`, startedAt: ts, finishedAt: ts },
    { type: 'text', text, startedAt: ts, finishedAt: ts },
  ]
  return { text, parts }
}

function splitText(text, count) {
  const width = Math.max(1, Math.ceil(text.length / count))
  const chunks = []
  for (let i = 0; i < text.length; i += width) chunks.push(text.slice(i, i + width))
  return chunks
}

/**
 * Grows the final parts into successive snapshots, one text chunk (or one
 * static part) at a time. Each snapshot is a prefix/superset of the next, so
 * consecutive diffs are pure array appends or pure string appends.
 */
export function partsProgression(parts) {
  const thinkingChunks = parts.find((p) => p.type === 'thinking')?.text
    ? splitText(parts.find((p) => p.type === 'thinking').text, 2)
    : []
  const textChunks = parts.find((p) => p.type === 'text')?.text
    ? splitText(parts.find((p) => p.type === 'text').text, 3)
    : []
  const statics = parts.filter((p) => p.type !== 'thinking' && p.type !== 'text')

  const steps = []
  let current = []

  const pushStep = () => steps.push(current.map((p) => ({ ...p })))

  const thinkingIndex = parts.findIndex((p) => p.type === 'thinking')
  const textIndex = parts.findIndex((p) => p.type === 'text')

  if (thinkingIndex !== -1) {
    current.push({ ...parts[thinkingIndex], text: '' })
    for (const chunk of thinkingChunks) {
      current[current.length - 1] = { ...current[current.length - 1], text: current[current.length - 1].text + chunk }
      pushStep()
    }
  }

  if (textIndex !== -1) {
    current.push({ ...parts[textIndex], text: '' })
    for (const chunk of textChunks) {
      current[current.length - 1] = { ...current[current.length - 1], text: current[current.length - 1].text + chunk }
      pushStep()
    }
  }

  for (const part of statics) {
    current.push({ ...part })
    pushStep()
  }

  return steps
}
