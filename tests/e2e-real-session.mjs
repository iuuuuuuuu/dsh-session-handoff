/**
 * End-to-end check against a real session transcript.
 *
 * Drives the same functions the plugin uses, on real data from an archived
 * session, and reports what a handoff would carry. Read-only.
 */
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import { extractFacts, collectCheckpoints, toBlocks, buildSeed, recentTurns } from '../lib/memory.js'
import { summarizeBlocks } from '../lib/summarize.js'
import { inputBudget, estimateTokens } from '../lib/token-budget.js'
import { classify, resolvePolicy } from '../lib/pressure.js'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const path = process.argv[2]
const buf = readFileSync(path)
const events = []
let pos = 0
while (pos < buf.length) {
  let decoded
  try { decoded = zstdDecompressSync(buf.subarray(pos)) } catch { break }
  if (!decoded.length) break
  const text = decoded.toString('utf8')
  if (text[0] !== '{') break
  for (const line of text.split('\n')) {
    if (!line || line[0] !== '{') continue
    try { events.push(JSON.parse(line)) } catch {}
  }
  let i = buf.indexOf(MAGIC, pos + 4)
  let next = -1
  while (i >= 0) {
    try { const d2 = zstdDecompressSync(buf.subarray(i)); if (d2.length && d2.toString('utf8')[0] === '{') { next = i; break } } catch {}
    i = buf.indexOf(MAGIC, i + 1)
  }
  if (next < 0) break
  pos = next
}
console.log('events decoded: ' + events.length)

// Reconstruct model-visible messages the way the session surface does.
const messages = []
for (const event of events) {
  if (event.type === 'user/message') messages.push({ role: 'user', content: event.data?.content ?? [] })
  else if (event.type === 'assistant/message') messages.push({ role: 'assistant', content: event.data?.message?.content ?? [] })
  else if (event.type === 'tool/result') messages.push({ role: 'tool', content: event.data?.message?.content ?? [] })
}
console.log('model messages: ' + messages.length)

const allText = messages.map((m) => (m.content || []).filter((b) => b && b.type === 'text').map((b) => b.text).join('\n')).join('\n')
const facts = extractFacts(allText)
const factCount = Object.values(facts).reduce((sum, list) => sum + list.length, 0)
console.log('extracted facts: ' + factCount + ' ' + JSON.stringify(Object.entries(facts).map(([k, v]) => k + '=' + v.length)))
const checkpoints = collectCheckpoints(events)
console.log('usable checkpoints: ' + checkpoints.length + ' (' + checkpoints.reduce((s, c) => s + estimateTokens(c.text), 0) + ' tokens)')

const blocks = toBlocks(messages)
const transcriptTokens = blocks.reduce((sum, b) => sum + b.tokens, 0)
console.log('transcript size: ' + transcriptTokens.toLocaleString('en-US') + ' estimated tokens across ' + blocks.length + ' blocks')

const policy = resolvePolicy({})
const cls = classify({ pressureTokens: transcriptTokens, modelWindow: 1000000, policy })
console.log('classification at that size: ' + cls.level + ' (binding ' + cls.binding + ')')
const budget = inputBudget(1000000, 1600)
console.log('per-request input budget: ' + budget.toLocaleString('en-US') + ' tokens')

// Prove the old approach would have failed and the new one cannot.
console.log('\n--- would the naive single request have been rejected? ---')
console.log('  naive request carries: ' + transcriptTokens.toLocaleString('en-US') + ' tokens')
console.log('  upstream prompt limit: ' + policy.upstreamPromptLimit.toLocaleString('en-US') + ' tokens')
console.log('  verdict: ' + (transcriptTokens > policy.upstreamPromptLimit ? 'REJECTED (this is the 11133 deadlock)' : 'would have fit'))

// Build a seed with facts + checkpoints only (no model call needed).
const recentShare = Math.max(512, Math.floor(policy.seedBudgetTokens * policy.recentShareRatio))
const recent = recentTurns(messages, recentShare)
console.log('verbatim recent turns kept: ' + recent.blocks.length + ' of ' + messages.length + (recent.truncated ? ' (trimmed)' : ''))
const seed = buildSeed({ facts, checkpoints, recent: recent.blocks, prose: '', budgetTokens: policy.seedBudgetTokens + recentShare })
console.log('\nseed from facts+checkpoints only: ' + seed.text.length + ' chars (~' + estimateTokens(seed.text) + ' tokens)')
console.log('notes: ' + JSON.stringify(seed.notes))
const tailIndex = seed.text.indexOf('## Most recent turns')
console.log('\n=== verbatim tail section ===')
console.log(tailIndex < 0 ? '(absent)' : seed.text.slice(tailIndex, tailIndex + 1400))
console.log('\n=== seed preview (first 1200 chars) ===')
console.log(seed.text.slice(0, 1200))
