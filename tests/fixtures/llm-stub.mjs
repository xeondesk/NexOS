// Deterministic OpenAI-compatible `/chat/completions` SSE stub used by
// tests/api-model-smoke.sh. Every POST is appended to the JSONL file given as
// the first argument (or LLM_STUB_LOG), so the smoke test can assert what the
// gateway sent (model, auth header, messages incl. conversation history).
//
// Response text defaults to "Hello" (LLM_STUB_TEXT) streamed as two content
// deltas after one reasoning_content delta, then `data: [DONE]`.
//
// Port: first argument, or LLM_STUB_PORT, or 9995.

import http from 'node:http'
import fs from 'node:fs'

const port = Number(process.argv[2] || process.env.LLM_STUB_PORT || 9995)
const logFile = process.argv[3] || process.env.LLM_STUB_LOG || ''
const fullText = process.env.LLM_STUB_TEXT || 'Hello'
const mid = Math.ceil(fullText.length / 2)

const server = http.createServer((req, res) => {
  let raw = ''
  req.on('data', (chunk) => (raw += chunk))
  req.on('end', () => {
    if (logFile) {
      fs.appendFileSync(
        logFile,
        `${JSON.stringify({ path: req.url, auth: req.headers.authorization || '', body: raw })}\n`,
      )
    }
    if (req.method !== 'POST' || !req.url.endsWith('/chat/completions')) {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end('{"message":"not_found"}')
      return
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.write('data: {"choices":[{"delta":{"reasoning_content":"scoping"}}]}\n\n')
    res.write(`data: {"choices":[{"delta":{"content":"${fullText.slice(0, mid)}"}}]}\n\n`)
    res.write(`data: {"choices":[{"delta":{"content":"${fullText.slice(mid)}"}}]}\n\n`)
    res.write('data: [DONE]\n\n')
    res.end()
  })
})

server.listen(port, () => console.log(`llm-stub on ${port}`))