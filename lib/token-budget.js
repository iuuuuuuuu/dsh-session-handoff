/**
 * Token budgeting for handoff summarization.
 *
 * The whole point of this plugin is to survive a session whose context already
 * exceeds the upstream prompt limit. Earlier tooling built a summarization
 * request from the *entire* shadowed region, so the request failed with the same
 * overflow it was meant to cure. Every request this module sizes must therefore
 * be independently bounded.
 *
 * @module dsh-session-handoff/token-budget
 */

/** Fraction of the model window a single summarization request may occupy. */
export const REQUEST_WINDOW_FRACTION = 0.5

/** Output tokens reserved for one chunk summary. */
export const CHUNK_SUMMARY_MAX_TOKENS = 1600

/** Output tokens reserved for the final merged summary. */
export const FINAL_SUMMARY_MAX_TOKENS = 6000

/**
 * Estimate tokens for a string without a tokenizer.
 *
 * Deliberately pessimistic: over-estimating shrinks each chunk (more chunks,
 * more requests) which is always safe, while under-estimating produces a
 * request the provider rejects.
 *
 * @param {string} text - source text.
 * @returns {number} estimated token count, never negative.
 */
export function estimateTokens(text) {
  if (typeof text !== 'string' || text.length === 0) return 0
  let ascii = 0
  let wide = 0
  for (const ch of text) {
    if (ch.codePointAt(0) > 0x2e80) wide += 1
    else ascii += 1
  }
  // Wide (CJK) glyphs are ~1 token each; ASCII runs ~4 characters per token.
  return Math.ceil(wide + ascii / 4)
}

/**
 * Derive the per-request input budget from a model window.
 *
 * @param {number} modelWindow - the routed model's context window in tokens.
 * @param {number} outputReserve - tokens this request reserves for its completion.
 * @returns {number} maximum estimated input tokens one request may carry.
 */
export function inputBudget(modelWindow, outputReserve) {
  const window = Number.isFinite(modelWindow) && modelWindow > 0 ? modelWindow : 128000
  const reserve = Number.isFinite(outputReserve) && outputReserve > 0 ? outputReserve : CHUNK_SUMMARY_MAX_TOKENS
  const usable = Math.floor(window * REQUEST_WINDOW_FRACTION) - reserve
  return Math.max(2048, usable)
}

/**
 * Pack ordered sized items into chunks that each fit a budget.
 *
 * @param {Array<{tokens?: number}>} items - ordered items carrying a token estimate.
 * @param {number} budget - maximum estimated tokens per chunk.
 * @returns {Array<Array<object>>} chunks, each an ordered slice of items.
 */
export function packChunks(items, budget) {
  const chunks = []
  let current = []
  let used = 0
  for (const item of items) {
    const cost = Math.max(0, item && item.tokens ? item.tokens : 0)
    if (current.length > 0 && used + cost > budget) {
      chunks.push(current)
      current = []
      used = 0
    }
    current.push(item)
    used += cost
  }
  if (current.length > 0) chunks.push(current)
  return chunks
}

/**
 * Truncate text to a token budget, keeping the head and the tail.
 *
 * Head and tail carry task framing and the most recent decisions; the middle of
 * a long tool result is the least informative part.
 *
 * @param {string} text - source text.
 * @param {number} budget - maximum estimated tokens.
 * @returns {{text: string, truncated: boolean}} the text, or a head+tail excerpt.
 */
export function truncateToBudget(text, budget) {
  if (estimateTokens(text) <= budget) return { text, truncated: false }
  const marker = '\n\n[... middle elided by dsh-session-handoff ...]\n\n'
  const markerCost = estimateTokens(marker)
  // When the budget cannot hold the marker plus a token of content, cut hard.
  if (budget <= markerCost + 4) {
    return { text: sliceForBudget(text, Math.max(1, budget), 'head'), truncated: true }
  }
  const room = budget - markerCost
  const headBudget = Math.floor(room * 0.6)
  const tailBudget = room - headBudget
  const head = sliceForBudget(text, headBudget, 'head')
  const tail = sliceForBudget(text, tailBudget, 'tail')
  return { text: head + marker + tail, truncated: true }
}

/**
 * Slice text so the result fits a token budget under the text's own density.
 *
 * A fixed characters-per-token ratio cannot work: CJK text costs about one token
 * per character while ASCII costs about one token per four, so a ratio tuned for
 * one overruns the budget on the other. The density is measured from the text
 * itself, then verified and shrunk if the estimate disagrees.
 *
 * @param {string} text - source text.
 * @param {number} budget - maximum estimated tokens.
 * @param {'head'|'tail'} side - which end to keep.
 * @returns {string} the slice, guaranteed within budget.
 */
function sliceForBudget(text, budget, side) {
  if (budget <= 0) return ''
  let chars = charsForBudget(text, budget)
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const slice = side === 'head' ? text.slice(0, chars) : text.slice(text.length - chars)
    if (estimateTokens(slice) <= budget) return slice
    chars = Math.floor(chars * 0.7)
    if (chars < 1) return ''
  }
  return ''
}

/**
 * Estimate how many characters of this text fit a token budget.
 *
 * @param {string} text - source text.
 * @param {number} budget - token budget.
 * @returns {number} a character count to try first.
 */
function charsForBudget(text, budget) {
  if (text.length === 0) return 0
  const sample = text.slice(0, Math.min(text.length, 4096))
  const sampleTokens = estimateTokens(sample)
  // Empty sample or an all-whitespace one: assume the densest case (1 char/token).
  if (sampleTokens <= 0) return Math.min(text.length, budget)
  const density = sampleTokens / sample.length
  const chars = Math.floor(budget / density)
  return Math.max(1, Math.min(text.length, chars))
}
