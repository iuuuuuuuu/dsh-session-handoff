/**
 * Layered memory extraction for a handoff.
 *
 * A handoff is only useful when the successor can continue the work, so the
 * design question is what to carry. This module answers it with three layers,
 * ordered by cost:
 *
 *   1. **Structured facts** — file paths, commands, identifiers, error strings.
 *      Extracted deterministically from the source text: no model call, no
 *      truncation risk, exact fidelity.
 *   2. **Existing checkpoints** — compaction summaries the session already
 *      produced. Already dense, already paid for.
 *   3. **Narrative summary** — model-written prose, produced by chunked
 *      map-reduce so no single request can overflow.
 *
 * The caller decides how much of each layer to keep. The default policy keeps
 * every fact and checkpoint (they are cheap and precise) and gives the prose the
 * remaining budget.
 *
 * @module dsh-session-handoff/memory
 */
import { estimateTokens, truncateToBudget } from './token-budget.js'

/** Patterns whose matching text is worth carrying verbatim. */
/**
 * Characters that may not appear inside a captured path.
 *
 * Besides the usual shell and Markdown metacharacters this excludes the CJK
 * blocks and their punctuation: in real transcripts a path is routinely
 * followed immediately by Chinese prose with no separator, and a naive
 * `[^\s]+` run swallows that prose into the captured path.
 */
const PATH_STOP = "\\s\"'<>,|*?\\n\\r\\t\\x60\\u3000-\\u303f\\u3040-\\u30ff\\u3400-\\u4dbf\\u4e00-\\u9fff\\uff00-\\uffef"

const FACT_PATTERNS = [
  {
    kind: 'path',
    // Absolute Windows and POSIX paths, with an optional :line or :line-line suffix.
    re: new RegExp('(?:[A-Za-z]:\\\\[^' + PATH_STOP + ']+|/(?:Users|home|opt|srv|var|etc|tmp|mnt)/[^' + PATH_STOP + ']+)(?::\\\\d+(?:-\\\\d+)?)?', 'g'),
  },
  {
    kind: 'error',
    re: /"(?:code|message|error)":\s*"([^"]{6,180})"|(?:code|错误码|状态码)["'\s:=]+([0-9]{3,5})/g,
  },
  {
    kind: 'command',
    re: /\b(?:pnpm|cargo|npm|git|node|python|pwsh|powershell|dsh)\s+(?:run\s+)?[a-z0-9:_-]+(?:\s+[^\s\n\r\t\x60\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]{1,60})?/gi,
  },
  {
    kind: 'identifier',
    re: /\b(?:session-[0-9a-f-]{20,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{7,40})\b/g,
  },
]

/** Maximum distinct facts retained per kind. */
const FACTS_PER_KIND = 60

/** Maximum characters retained for one fact. */
const FACT_MAX_CHARS = 200

/**
 * Reduce a fact to a shape that ignores generated segments.
 *
 * `target/debug/build/ai-gateway-core-0f9f49ff.../out/gateway_embed.gz` and its
 * forty siblings share one shape, so they collapse to a single representative
 * instead of consuming the whole per-kind budget.
 *
 * @param {string} value - one captured fact.
 * @returns {string} the shape used for deduplication.
 */
function factShape(value) {
  return value
    // Long hex runs are build hashes, commit suffixes, or generated ids.
    .replace(/[0-9a-f]{8,}/gi, '#')
    // Numeric segments are counters, ports, or chunk indices.
    .replace(/\d+/g, '#')
}

/** Directory fragments that mark a generated or vendored path. */
const LOW_VALUE_FRAGMENTS = [
  '\\target\\debug\\', '\\target\\release\\', '\\node_modules\\',
  '\\dist\\', '\\.git\\', '\\build\\', '\\out\\', '\\.cache\\',
  '\\coverage\\', '\\tmp\\', '\\temp\\',
]

/**
 * Score how useful a fact is to a reader continuing the work.
 *
 * Source files, configuration and documents outrank generated trees: the
 * successor needs to know what was edited, not which build artifact directory
 * happened to exist.
 *
 * @param {string} value - one captured fact.
 * @param {string} kind - which pattern produced it.
 * @returns {number} higher is more useful.
 */
function factRank(value, kind) {
  if (kind !== 'path') return 2
  const lower = value.toLowerCase()
  for (const fragment of LOW_VALUE_FRAGMENTS) {
    if (lower.includes(fragment)) return 0
  }
  return 1
}

/**
 * Extract verbatim, high-value facts from arbitrary conversation text.
 *
 * Deduplicates by exact text, keeps first-seen order, and caps both the per-kind
 * count and the per-fact length so a pathological log cannot explode the seed.
 *
 * @param {string} text - concatenated conversation text.
 * @returns {Record<string, string[]>} facts grouped by kind.
 */
export function extractFacts(text) {
  const source = typeof text === 'string' ? text : ''
  const out = {}
  for (const pattern of FACT_PATTERNS) {
    // Collect every distinct match with its last position, then keep the most
    // recent ones. A long session's opening paths are stale by the time it is
    // handed off; what the successor needs is what was touched lately.
    const latest = new Map()
    for (const match of source.matchAll(pattern.re)) {
      // Patterns with capture groups isolate the value from its surrounding
      // syntax ("code":"11133" -> 11133); prefer the first non-empty group.
      const captured = match.slice(1).find((group) => typeof group === 'string' && group.length > 0)
      const value = cleanFact(captured ?? String(match[0] || ''), pattern.kind)
      if (value.length < 3) continue
      latest.set(value, match.index ?? 0)
    }
    if (latest.size === 0) continue
    const ranked = [...latest.entries()]
      .sort((a, b) => a[1] - b[1])
      .map((entry) => ({ value: entry[0], at: entry[1], rank: factRank(entry[0], pattern.kind) }))
    // Collapse values that differ only in a generated segment, then prefer the
    // most useful class of fact, then the most recent, then keep the cap.
    const byShape = new Map()
    for (const item of ranked) {
      const shape = factShape(item.value)
      const existing = byShape.get(shape)
      // Keep the higher-ranked representative, breaking ties by recency.
      if (existing === undefined || item.rank > existing.rank || (item.rank === existing.rank && item.at > existing.at)) {
        byShape.set(shape, item)
      }
    }
    const list = [...byShape.values()]
      .sort((a, b) => (a.rank - b.rank) || (a.at - b.at))
      .slice(-FACTS_PER_KIND)
      .map((item) => item.value)
    out[pattern.kind] = list
  }
  return out
}

/**
 * Normalize one captured fact.
 *
 * Captures routinely pick up trailing punctuation from surrounding prose — a
 * closing bracket from a stack trace, a sentence period, a Markdown backtick —
 * which would otherwise make the same path look like several different ones.
 *
 * @param {string} raw - the captured text.
 * @param {string} kind - which pattern produced it.
 * @returns {string} the trimmed fact, within the per-fact length cap.
 */
function cleanFact(raw, kind) {
  let value = raw.trim()
  if (kind === 'path' || kind === 'command') {
    // Strip trailing punctuation that belongs to the prose, not the path.
    value = value.replace(/[)\]}>.,;:'"`]+$/g, '').trim()
    // A command capture may pick up a following connective word ("and", "then").
    value = value.replace(/\s+(?:and|then|or|but|with|to|for)$/i, '').trim()
  }
  return value.length > FACT_MAX_CHARS ? value.slice(0, FACT_MAX_CHARS) : value
}

/**
 * Collect the compaction checkpoints a session already produced.
 *
 * @param {Array<object>} events - the session's events in log order.
 * @returns {Array<{seq: number, text: string}>} summaries oldest-first.
 */
export function collectCheckpoints(events) {
  const checkpoints = []
  const list = Array.isArray(events) ? events : []
  for (const event of list) {
    if (!event || event.type !== 'compaction/end') continue
    if (event.data && event.data.error !== undefined) continue
    const text = extractCheckpointText(event)
    if (typeof text === 'string' && text.length > 0) checkpoints.push({ seq: event.seq, text })
  }
  return checkpoints
}

/**
 * Read the human-readable summary out of one successful `compaction/end`.
 *
 * The event shape has changed across releases, so several known carriers are
 * probed rather than assuming one.
 *
 * @param {object} event - a successful compaction/end event.
 * @returns {string|undefined} the summary text, when this event carries one.
 */
export function extractCheckpointText(event) {
  const data = (event && event.data) || {}
  for (const key of ['summary', 'text', 'checkpoint', 'message']) {
    const candidate = data[key]
    if (typeof candidate === 'string' && candidate.trim().length > 0) return candidate.trim()
  }
  const blocks = data.summaryBlocks || data.blocks
  if (Array.isArray(blocks)) {
    const joined = blocks
      .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n')
      .trim()
    if (joined.length > 0) return joined
  }
  return undefined
}

/**
 * Turn model messages into ordered text blocks suitable for chunking.
 *
 * Only model-visible content is included: user messages, assistant text (never
 * hidden reasoning), tool results and tool-call signatures. Tool calls are kept
 * because they record *what was attempted*.
 *
 * @param {Array<object>} messages - messages from `Session.deriveMessages()`.
 * @returns {Array<{index: number, role: string, text: string, tokens: number}>} blocks.
 */
export function toBlocks(messages) {
  const blocks = []
  const list = Array.isArray(messages) ? messages : []
  for (let index = 0; index < list.length; index += 1) {
    const message = list[index]
    const role = message && typeof message.role === 'string' ? message.role : 'unknown'
    const text = renderMessage(message)
    if (text.length === 0) continue
    blocks.push({ index, role, text, tokens: estimateTokens(text) })
  }
  return blocks
}

/**
 * Render one message to plain text.
 *
 * @param {object} message - one model message.
 * @returns {string} its textual content, or an empty string when it has none.
 */
export function renderMessage(message) {
  const content = message && message.content
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (!block) continue
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    else if (block.type === 'tool-call') {
      const name = block.name || 'tool'
      const args = typeof block.arguments === 'string' ? block.arguments : JSON.stringify(block.arguments || {})
      parts.push('[tool-call ' + name + '] ' + args)
    }
  }
  return parts.join('\n').trim()
}

/**
 * Patterns for credential-shaped strings that must never enter a handoff seed.
 *
 * The verbatim layer is a copy, so anything the session ever echoed would be
 * copied too — including a token someone printed while debugging. The old session
 * already contains it; a handoff seed is a new artifact that may be read, exported
 * or shared, so it is redacted by shape rather than trusted.
 *
 * Each entry keeps a short prefix so a reader can still tell WHAT was redacted
 * without learning its value.
 */
const SECRET_PATTERNS = [
  // Authorization headers and bearer tokens.
  { re: /\b(Bearer|Basic|token)\s+[A-Za-z0-9._~+/-]{16,}=*/gi, replace: '$1 <redacted>' },
  // Provider key shapes: sk-..., ghp_..., github_pat_..., xoxb-...
  { re: /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g, replace: '<redacted-key>' },
  { re: /\bgh[pousr]_[A-Za-z0-9]{20,}/g, replace: '<redacted-github-token>' },
  { re: /\bgithub_pat_[A-Za-z0-9_]{20,}/g, replace: '<redacted-github-token>' },
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g, replace: '<redacted-slack-token>' },
  { re: /\bAKIA[0-9A-Z]{16}\b/g, replace: '<redacted-aws-key>' },
  { re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, replace: '<redacted-jwt>' },
  // A QUOTED value after a secret-ish key. This must run before the unquoted rule
  // below, which would otherwise consume the opening quote and leave the tail.
  {
    re: /\b(password|passwd|secret|api[_-]?key|apikey|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key)\b\s*[:=]\s*"([^"]{6,})"/gi,
    replace: '$1="<redacted>"',
  },
  // Key/value assignments in configs, dotenv files and shell exports.
  {
    re: /\b(password|passwd|secret|api[_-]?key|apikey|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key)\b\s*[:=]\s*["']?([^\s"',;]{6,})/gi,
    replace: '$1=<redacted>',
  },
  // Connection strings with an inline password.
  { re: /:\/\/[^:/\s@]{1,64}:[^@/\s]{6,}@/g, replace: '://<redacted>:<redacted>@' },
  // PEM private-key blocks, whole.
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, replace: '<redacted-private-key>' },
  // An unterminated PEM header (a truncated paste) is still a key.
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g, replace: '<redacted-private-key>' },
]

/**
 * Remove credential-shaped strings from text destined for a handoff seed.
 *
 * @param {string} text - source text.
 * @returns {{text: string, redactions: number}} the redacted text and how many hits.
 */
export function redactSecrets(text) {
  if (typeof text !== 'string' || text.length === 0) return { text: text ?? '', redactions: 0 }
  let out = text
  let redactions = 0
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern.re, (...args) => {
      redactions += 1
      const replacement = pattern.replace
      // Support $1-style backreferences in the replacement.
      return replacement.replace(/\$(\d)/g, (_, index) => String(args[Number(index)] ?? ''))
    })
  }
  return { text: out, redactions }
}

/**
 * Keep the most recent turns verbatim.
 *
 * Facts give exact paths and commands; the narrative summary paraphrases. Neither
 * preserves the *exact* recent exchange, which is what a successor needs to pick
 * up mid-thought — the last instruction, the last thing that was tried, the last
 * error. This layer keeps the tail word-for-word under its own token budget.
 *
 * Selection walks backwards from the newest message and stops at a turn boundary
 * so the kept span is always a whole exchange, never half of one.
 *
 * @param {Array<object>} messages - messages in order, oldest first.
 * @param {number} budgetTokens - maximum tokens this layer may occupy.
 * @returns {{blocks: Array<object>, dropped: number, truncated: boolean}} the kept tail.
 */
export function recentTurns(messages, budgetTokens) {
  const list = Array.isArray(messages) ? messages : []
  if (list.length === 0 || budgetTokens <= 0) return { blocks: [], dropped: 0, truncated: false }

  const rendered = []
  for (const message of list) {
    const text = renderMessage(message)
    if (text.length === 0) continue
    const role = message && typeof message.role === 'string' ? message.role : 'unknown'
    rendered.push({ role, text, tokens: estimateTokens(text) })
  }
  if (rendered.length === 0) return { blocks: [], dropped: 0, truncated: false }

  // Walk backwards accumulating whole messages until the budget would be exceeded.
  const kept = []
  let used = 0
  let truncated = false
  for (let index = rendered.length - 1; index >= 0; index -= 1) {
    const block = rendered[index]
    if (used + block.tokens > budgetTokens) {
      // A single newest message larger than the whole budget still has to be
      // represented, so it is truncated rather than dropped.
      if (kept.length === 0) {
        const fitted = truncateToBudget(block.text, budgetTokens)
        kept.unshift({ ...block, text: fitted.text, tokens: budgetTokens })
        used = budgetTokens
        truncated = true
      } else {
        truncated = true
      }
      break
    }
    kept.unshift(block)
    used += block.tokens
  }

  // Trim the leading edge to a turn boundary: a kept span that starts mid-exchange
  // reads as though the successor said something it never said.
  while (kept.length > 1 && kept[0].role === 'assistant') kept.shift()

  return { blocks: kept, dropped: rendered.length - kept.length, truncated }
}

/**
 * Render the verbatim tail as a Markdown section.
 *
 * @param {Array<object>} blocks - blocks from {@link recentTurns}.
 * @returns {string} the section, or an empty string.
 */
export function renderRecentTurns(blocks) {
  const list = Array.isArray(blocks) ? blocks : []
  if (list.length === 0) return ''
  const lines = ['## Most recent turns, verbatim', '', 'These are the last exchanges exactly as they happened, so you can continue mid-thought.', '']
  for (const block of list) {
    lines.push('### ' + block.role)
    // The verbatim layer is a copy, so it is the one place a credential could ride
    // along. Redact here rather than trusting the transcript to be clean.
    lines.push(redactSecrets(block.text).text)
    lines.push('')
  }
  return lines.join('\n').trim()
}

/**
 * Build the final seed text from the layers under one token budget.
 *
 * Layers are added in priority order and only the *prose* layer absorbs the
 * remaining budget: facts and checkpoints are exact and cheap, so they are never
 * dropped for prose. Only prose is truncated, and only from its middle.
 *
 * @param {{facts: object, checkpoints: Array<object>, prose: string, budgetTokens: number}} input - layers and budget.
 * @returns {{text: string, notes: string[]}} the seed text and what fitting it cost.
 */
export function buildSeed(input) {
  const facts = input.facts || {}
  const checkpoints = input.checkpoints || []
  const budgetTokens = input.budgetTokens
  const sections = []
  const notes = []

  // Priority order. Facts and checkpoints are exact and cheap, so they are never
  // dropped. The verbatim tail is exact too, so it outranks the paraphrase.
  const factSection = renderFacts(facts)
  if (factSection.length > 0) sections.push(factSection)

  const checkpointSection = renderCheckpoints(checkpoints)
  if (checkpointSection.length > 0) sections.push(checkpointSection)

  const recentSection = renderRecentTurns(input.recent)
  if (recentSection.length > 0) sections.push(recentSection)

  const fixedCost = estimateTokens(sections.join('\n\n'))
  let proseText = typeof input.prose === 'string' ? input.prose.trim() : ''
  if (proseText.length > 0) {
    const proseBudget = budgetTokens - fixedCost
    if (proseBudget < 256) {
      notes.push('prose summary dropped: the exact layers already fill the seed budget')
      proseText = ''
    } else {
      const fitted = truncateToBudget(proseText, proseBudget)
      if (fitted.truncated) notes.push('prose summary truncated from its middle to fit the seed budget')
      proseText = fitted.text
    }
  }

  if (proseText.length > 0) sections.push(['## Narrative summary', '', proseText].join('\n'))
  return { text: sections.join('\n\n'), notes }
}

/**
 * @param {object} facts - grouped facts.
 * @returns {string} a Markdown section, or an empty string.
 */
function renderFacts(facts) {
  const groups = Object.entries(facts || {}).filter((entry) => Array.isArray(entry[1]) && entry[1].length > 0)
  if (groups.length === 0) return ''
  const labels = {
    path: 'Paths touched',
    error: 'Errors and codes seen',
    command: 'Commands run',
    identifier: 'Identifiers',
  }
  const lines = ['## Verbatim facts (extracted, not paraphrased)', '']
  for (const entry of groups) {
    lines.push('**' + (labels[entry[0]] || entry[0]) + '**')
    for (const item of entry[1]) lines.push('- `' + redactSecrets(item).text + '`')
    lines.push('')
  }
  return lines.join('\n').trim()
}

/**
 * @param {Array<object>} checkpoints - checkpoint list.
 * @returns {string} a Markdown section, or an empty string.
 */
function renderCheckpoints(checkpoints) {
  const list = Array.isArray(checkpoints) ? checkpoints : []
  if (list.length === 0) return ''
  const lines = ['## Earlier checkpoints this session already wrote', '']
  for (const checkpoint of list) {
    lines.push('### checkpoint at seq ' + checkpoint.seq)
    lines.push(checkpoint.text)
    lines.push('')
  }
  return lines.join('\n').trim()
}
