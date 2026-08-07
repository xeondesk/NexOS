// v0 stream delta format — ported from vercel/v0-sdk `stream/diffpatch.ts`
// (Apache-2.0, https://github.com/vercel/v0-sdk).
//
// Deltas on the v2 streaming wire are standard jsondiffpatch deltas, plus a v0
// string-append fast-path: `[[idx, ..., "appended"], 9, 9]`. The trailing
// `[9, 9]` marks "append-only string delta"; the integer path walks into
// `parts[i].text` (etc.) and the final string is the appended tail. This is
// how token streaming is made cheap over the wire.

import * as jsondiffpatch from 'jsondiffpatch'

const jsonDiffPatcher = jsondiffpatch.create({})

export function isV0StringAppendDelta(delta) {
  if (!Array.isArray(delta)) return false
  const path = delta[0]
  if (!Array.isArray(path) || path.length === 0) return false
  const appendedText = path[path.length - 1]
  return (
    delta[1] === 9 &&
    delta[2] === 9 &&
    typeof appendedText === 'string' &&
    path.slice(0, -1).every((segment) => Number.isInteger(segment))
  )
}

function isArrayDelta(delta) {
  return typeof delta === 'object' && delta !== null && '_t' in delta && delta._t === 'a'
}

function isArrayStringAppend(delta) {
  if (!isArrayDelta(delta)) return false

  let index = -1
  let removedIndex = -1

  for (const key in delta) {
    if (key === '_t') continue

    if (key.startsWith('_')) {
      removedIndex = Number(key.slice(1))
      continue
    }

    if (index !== -1) return false

    index = Number(key)
  }

  if (index === -1) return false

  if (removedIndex === -1) {
    const nestedDelta = delta[index]
    const result = isArrayStringAppend(nestedDelta)
    if (result === false) return false
    return [index, ...result]
  }

  if (index !== removedIndex) return false

  const deltaNew = delta[index]
  const deltaOld = delta[`_${removedIndex}`]

  if (
    Array.isArray(deltaNew) &&
    deltaNew.length === 1 &&
    typeof deltaNew[0] === 'string' &&
    Array.isArray(deltaOld) &&
    deltaOld.length === 3 &&
    typeof deltaOld[0] === 'string' &&
    deltaOld[1] === 0 &&
    deltaOld[2] === 0
  ) {
    const newString = deltaNew[0]
    const oldString = deltaOld[0]

    if (newString.startsWith(oldString)) {
      return [index, newString.slice(oldString.length)]
    }
  }

  return false
}

/** Computes the v0 wire delta between two values (append fast-path included). */
export function diff(original, modified) {
  const delta = jsonDiffPatcher.diff(original, modified)
  const maybeStringAppend = isArrayStringAppend(delta)

  if (maybeStringAppend !== false) {
    return [maybeStringAppend, 9, 9]
  }

  return delta
}

/** Applies a v0 wire delta to a value (append fast-path included). */
export function patch(original, delta) {
  if (!delta) return original

  try {
    const newValue = jsonDiffPatcher.clone(original)

    if (isV0StringAppendDelta(delta)) {
      return applyStringAppendDelta(newValue, delta)
    }

    return jsonDiffPatcher.patch(newValue, delta)
  } catch {
    return original
  }
}

function applyStringAppendDelta(original, delta) {
  const path = delta[0]
  const appendedText = path[path.length - 1]

  if (typeof appendedText !== 'string') return original

  const indexes = path.slice(0, -1)

  if (indexes.length === 0) {
    if (typeof original === 'string') return `${original}${appendedText}`
    return original
  }

  let current = original

  for (const index of indexes) {
    if (typeof current !== 'object' || current === null) return original
    const next = current[index]
    if (typeof next === 'string') {
      current[index] = `${next}${appendedText}`
      return original
    }
    current = next
  }

  return original
}
