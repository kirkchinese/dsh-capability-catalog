/**
 * Cuts that never split a Unicode surrogate pair.
 *
 * Cutting a string between the two halves of a surrogate pair leaves a lone code unit. `JSON.stringify`
 * then writes it as a bare `\uD8xx` escape, and a strict JSON reader rejects the whole payload — which
 * for this plugin means the provider refuses the request body that carries the rendered tool result.
 * Every model-facing cut goes through these helpers instead of `slice`.
 * @module
 */

/** First code unit of a high (leading) surrogate. */
const HIGH_START = 0xd800
/** Last code unit of a high (leading) surrogate. */
const HIGH_END = 0xdbff
/** First code unit of a low (trailing) surrogate. */
const LOW_START = 0xdc00
/** Last code unit of a low (trailing) surrogate. */
const LOW_END = 0xdfff

/**
 * The largest end index at or below `end` that does not leave a lone high surrogate behind.
 * A cut that lands inside a pair yields one code unit less, so the character is dropped whole.
 * @param text - text to cut.
 * @param end - candidate end index in UTF-16 code units.
 * @returns the end index to use.
 */
export function clipEnd(text: string, end: number): number {
  if (end <= 0) return 0
  if (end >= text.length) return text.length
  const unit = text.charCodeAt(end - 1)
  return unit >= HIGH_START && unit <= HIGH_END ? end - 1 : end
}

/**
 * A prefix of at most `maxChars` UTF-16 code units that never ends in a lone high surrogate.
 * The result is one code unit shorter than `maxChars` when the budget falls inside a pair.
 * @param text - text to shorten.
 * @param maxChars - character budget in UTF-16 code units.
 * @returns the prefix.
 */
export function clipHead(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return text.slice(0, clipEnd(text, maxChars))
}

/**
 * Whether `text` carries a lone surrogate, that is, a code unit whose pair was cut away.
 * Used by tests and by callers that want to assert well-formed output.
 * @param text - text to check.
 * @returns true when an unpaired surrogate is present.
 */
export function hasLoneSurrogate(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index)
    if (unit < HIGH_START || unit > LOW_END) continue
    if (unit > HIGH_END) return true // a low surrogate without its leading half
    const next = text.charCodeAt(index + 1)
    if (next >= LOW_START && next <= LOW_END) {
      index += 1
      continue
    }
    return true // a high surrogate without its trailing half
  }
  return false
}

/**
 * Replace every lone surrogate with U+FFFD.
 *
 * Cuts made here never split a pair, but text can arrive broken: an MCP server may return a string
 * decoded from binary data, or a description may already carry half a character. Every string this
 * plugin hands to the model passes through here, so one bad code unit cannot fail the whole request.
 * @param text - text to repair.
 * @returns well-formed text; the same string when nothing needed repair.
 */
export function wellFormed(text: string): string {
  const native = (text as string & { toWellFormed?: () => string }).toWellFormed
  if (typeof native === 'function') return native.call(text)
  return hasLoneSurrogate(text) ? text.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/gu, '\ufffd') : text
}

/**
 * Repair every string inside a JSON value, such as a tool schema sent as a native declaration.
 * @param value - JSON value.
 * @returns the value with well-formed strings; untouched values are returned as is.
 */
export function wellFormedDeep<T>(value: T): T {
  if (typeof value === 'string') return wellFormed(value) as T
  if (Array.isArray(value)) return value.map((item) => wellFormedDeep(item)) as T
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [wellFormed(key), wellFormedDeep(item)])) as T
  }
  return value
}
