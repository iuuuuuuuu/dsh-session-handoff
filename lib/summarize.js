/**
 * Overflow-proof summarization.
 *
 * The failure this module exists to prevent: building one request from an
 * entire oversized transcript. That request is itself over the upstream prompt
 * limit, so it fails with the same error the handoff was meant to cure — which
 * is exactly how a session becomes unrecoverable.
 *
 * The fix is map-reduce. Chunk the transcript to a budget derived from the model
 * window, summarize each chunk in its own bounded request, then merge the chunk
 * summaries (small by construction) in one final request. No single request ever
 * carries the whole transcript.
 *
 * @module dsh-session-handoff/summarize
 */
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import { CHUNK_SUMMARY_MAX_TOKENS, FINAL_SUMMARY_MAX_TOKENS, inputBudget, packChunks, truncateToBudget } from './token-budget.js'

/** Instruction for one chunk: keep facts, drop nothing that matters. */
const CHUNK_INSTRUCTION = [
  'Summarize the transcript section below.',
  'Keep exact file paths, commands, identifiers, error strings, and any decision together with its reason.',
  'Preserve what was attempted and how it turned out, including failures and their causes.',
  'Write dense bullet points. No preamble, no closing remarks, no tool calls.',
].join(' ')

/** Instruction for the merge: fold chunk summaries into one handoff brief. */
const MERGE_INSTRUCTION = [
  'The sections below summarize one long working session, in order.',
  'Merge them into a single handoff brief for an engineer who will continue this work with no other context.',
  'Structure it as: current goal and its state; what is already done and verified; what remains; decisions taken and why; constraints and hard rules that must not be violated; known traps and dead ends.',
  'Preserve exact paths, commands, identifiers and error strings verbatim. Prefer specifics over narrative.',
  'Output only the brief. No preamble, no tool calls.',
].join(' ')

/** Characters per estimated token used when bounding the merge request. */
const CHARS_PER_TOKEN = 1.6

/**
 * Summarize blocks with bounded requests.
 *
 * @param {{blocks: Array<object>, stream: Function, provider: string, model: string, modelWindow: number, signal?: AbortSignal, onProgress?: Function}} input - blocks, the llm caller, target and window.
 * @returns {Promise<{text: string, report: object}>} the merged summary plus a report.
 */
export async function summarizeBlocks(input) {
  const blocks = input.blocks
  const stream = input.stream
  const provider = input.provider
  const model = input.model
  const signal = input.signal
  const onProgress = input.onProgress
  const report = { chunks: 0, chunkFailures: 0, truncatedBlocks: 0, merged: false, degraded: false }

  if (!Array.isArray(blocks) || blocks.length === 0) {
    return { text: '', report: { ...report, degraded: true } }
  }

  const budget = inputBudget(input.modelWindow, CHUNK_SUMMARY_MAX_TOKENS)
  const perChunkBudget = Math.max(512, budget - 256)

  // A single block can exceed the whole budget (one giant tool result). Truncate
  // that block in place rather than dropping it, so ordering and coverage survive.
  const sized = blocks.map((block) => {
    if (block.tokens <= perChunkBudget) return block
    const fitted = truncateToBudget(block.text, perChunkBudget)
    report.truncatedBlocks += 1
    return { ...block, text: fitted.text, tokens: perChunkBudget }
  })

  const chunks = packChunks(sized, perChunkBudget)
  report.chunks = chunks.length

  const partials = []
  for (let index = 0; index < chunks.length; index += 1) {
    if (signal && signal.aborted) break
    const chunk = chunks[index]
    const body = chunk.map((block) => '### ' + block.role + '\n' + block.text).join('\n\n')
    if (typeof onProgress === 'function') onProgress({ phase: 'chunk', index: index + 1, total: chunks.length })
    try {
      const text = await askModel({ stream, provider, model, signal, instruction: CHUNK_INSTRUCTION, body, maxTokens: CHUNK_SUMMARY_MAX_TOKENS })
      if (text.length > 0) partials.push(text)
      else report.chunkFailures += 1
    } catch {
      // One failed chunk must not lose the others: the merge still runs.
      report.chunkFailures += 1
    }
  }

  if (partials.length === 0) return { text: '', report: { ...report, degraded: true } }
  if (partials.length === 1) return { text: partials[0], report }

  if (typeof onProgress === 'function') onProgress({ phase: 'merge', index: 1, total: 1 })
  const mergedBody = partials.map((text, index) => '### section ' + (index + 1) + '\n' + text).join('\n\n')
  // The merge request is small by construction, but bound it anyway: a
  // pathological run could still produce many partials.
  const mergeBudget = inputBudget(input.modelWindow, FINAL_SUMMARY_MAX_TOKENS)
  const fittedBody = mergedBody.length > mergeBudget * CHARS_PER_TOKEN
    ? truncateToBudget(mergedBody, mergeBudget).text
    : mergedBody
  try {
    const text = await askModel({ stream, provider, model, signal, instruction: MERGE_INSTRUCTION, body: fittedBody, maxTokens: FINAL_SUMMARY_MAX_TOKENS })
    if (text.length > 0) return { text, report: { ...report, merged: true } }
  } catch {
    report.degraded = true
  }
  // Merge failed: the concatenated partials are already useful, so keep them.
  return { text: partials.join('\n\n'), report: { ...report, degraded: true } }
}

/**
 * Run one bounded request through the llm service and return its text.
 *
 * @param {{stream: Function, provider: string, model: string, signal?: AbortSignal, instruction: string, body: string, maxTokens: number}} input - the caller, target, instruction and body.
 * @returns {Promise<string>} the assembled text, or an empty string when the model emitted none.
 * @throws {Error} when the attempt fails or is aborted.
 */
async function askModel(input) {
  const assembler = new BlockAssembler()
  const messages = [
    createUserMessage({
      content: [{ type: 'text', text: input.instruction + '\n\n' + input.body }],
      source: { kind: 'plugin', plugin: 'dsh-session-handoff' },
    }),
  ]
  const options = {
    provider: input.provider,
    model: input.model,
    messages,
    maxTokens: input.maxTokens,
    purpose: 'compaction',
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  }
  for await (const chunk of input.stream(options)) assembler.push(chunk)
  const finish = assembler.finish
  if (finish.kind === 'error' || finish.kind === 'aborted') {
    throw new Error((finish.failure && finish.failure.message) || 'summarization attempt failed')
  }
  return assembler
    .blocks()
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')
    .trim()
}
