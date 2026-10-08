/**
 * The handoff transaction.
 *
 * Ordering matters and is deliberate:
 *
 *   1. Read the source session **while it is still alive**. A session too large
 *      to compress is often also expensive to re-open, so the live handle is the
 *      only reliable reader.
 *   2. Build the seed before touching anything. If summarization fails outright,
 *      the source session is still intact and usable.
 *   3. Create the successor and deliver the seed.
 *   4. Archive the source **last**. Archiving is the only awkward-to-undo step,
 *      so nothing that can fail runs after it.
 *
 * Every step reports its own outcome, and a failed step degrades the result
 * instead of aborting: a successor carrying only extracted facts is still far
 * better than a session that cannot continue at all.
 *
 * @module dsh-session-handoff/handoff
 */
import { randomUUID } from 'node:crypto'
import { buildSeed, collectCheckpoints, extractFacts, recentTurns, renderMessage, toBlocks } from './memory.js'
import { resolvePolicy } from './pressure.js'
import { summarizeBlocks } from './summarize.js'
import { estimateTokens } from './token-budget.js'

/** Marker so a successor is recognisable as a handoff target. */
export const HANDOFF_MARKER = 'dsh-session-handoff'

/**
 * Run one handoff.
 *
 * @param {{ctx: object, agent: object, config?: object, signal?: AbortSignal, onProgress?: Function, request?: object}} input - services, source agent, options.
 * @returns {Promise<object>} a structured report; never throws for an expected failure.
 */
export async function runHandoff(input) {
  const ctx = input.ctx
  const agent = input.agent
  const policy = resolvePolicy((input.config && input.config.policy) || input.config)
  const session = agent && agent.session
  const report = {
    ok: false,
    sourceSessionId: session ? session.id : null,
    newSessionId: null,
    archived: false,
    released: false,
    summaryChars: 0,
    summarySource: 'none',
    facts: 0,
    checkpoints: 0,
    recentTurns: 0,
    seedChars: 0,
    seedTokens: 0,
    steps: [],
    warnings: [],
  }
  const step = (name, detail) => report.steps.push(detail === undefined ? { name } : { name, detail })

  if (session === undefined) {
    report.warnings.push('no source session on this agent')
    step('read', 'failed: no session')
    return report
  }

  // ── 1. read the live session ─────────────────────────────────────────────
  let messages = []
  let events = []
  try {
    messages = [...session.deriveMessages()]
    events = [...session.snapshotEvents()]
    step('read', messages.length + ' messages, ' + events.length + ' events')
  } catch (error) {
    report.warnings.push('could not read the session: ' + String((error && error.message) || error))
    step('read', 'failed')
    return report
  }

  // ── 2. layered memory ────────────────────────────────────────────────────
  const allText = messages.map((message) => renderMessage(message)).filter((text) => text.length > 0).join('\n')
  const facts = extractFacts(allText)
  report.facts = Object.values(facts).reduce((sum, list) => sum + list.length, 0)
  const checkpoints = collectCheckpoints(events)
  report.checkpoints = checkpoints.length
  step('memory', report.facts + ' facts, ' + report.checkpoints + ' checkpoints')

  // ── 3. narrative summary (bounded, map-reduce) ───────────────────────────
  let prose = ''
  const target = resolveTarget(agent, session)
  if (target === undefined) {
    report.warnings.push('no provider/model available; continuing with facts and checkpoints only')
    step('summarize', 'skipped: no model target')
  } else {
    try {
      const result = await summarizeBlocks({
        blocks: toBlocks(messages),
        stream: (options) => ctx.llm.stream(options),
        provider: target.provider,
        model: target.model,
        modelWindow: target.modelWindow,
        signal: input.signal,
        onProgress: input.onProgress,
      })
      prose = result.text
      report.summaryChars = prose.length
      report.summarySource = result.report.merged
        ? 'map-reduce'
        : (result.report.chunks > 1 ? 'concatenated-chunks' : 'single-pass')
      if (result.report.chunkFailures > 0) report.warnings.push(result.report.chunkFailures + ' of ' + result.report.chunks + ' summary chunks failed')
      if (result.report.truncatedBlocks > 0) report.warnings.push(result.report.truncatedBlocks + ' oversized block(s) truncated to fit a request')
      step('summarize', result.report.chunks + ' chunk(s), source=' + report.summarySource + ', ' + prose.length + ' chars')
    } catch (error) {
      report.warnings.push('summarization failed: ' + String((error && error.message) || error))
      step('summarize', 'failed; continuing with facts and checkpoints only')
    }
  }

  // ── 4. assemble the seed ─────────────────────────────────────────────────
  // The verbatim tail gets a reserved share so a long session cannot let prose
  // crowd out the exact recent exchange. Facts and checkpoints take what they
  // need first; this share is what the tail may claim.
  const recentShare = Math.max(512, Math.floor(policy.seedBudgetTokens * policy.recentShareRatio))
  const recent = recentTurns(messages, recentShare)
  if (recent.blocks.length > 0) {
    report.recentTurns = recent.blocks.length
    step('recent', recent.blocks.length + ' verbatim message(s)' + (recent.truncated ? ' (trimmed to the budget)' : ''))
  }
  const seed = buildSeed({
    facts,
    checkpoints,
    recent: recent.blocks,
    prose,
    budgetTokens: policy.seedBudgetTokens + recentShare,
  })
  if (seed.notes.length > 0) report.warnings.push(...seed.notes)
  const seedText = wrapSeed(seed.text, session, report)
  report.seedChars = seedText.length
  report.seedTokens = estimateTokens(seedText)
  step('seed', seedText.length + ' chars (~' + report.seedTokens + ' tokens)')

  // ── 5. create the successor ──────────────────────────────────────────────
  let newSessionId = null
  try {
    newSessionId = await createSuccessor({ ctx, session, seedText, request: input.request })
    report.newSessionId = newSessionId
    step('create', newSessionId)
  } catch (error) {
    report.warnings.push('could not create the successor: ' + String((error && error.message) || error))
    // Keep the stack so a harness-side failure stays diagnosable from the log.
    if (error && error.stack) report.warnings.push('stack: ' + String(error.stack).split('\n').slice(0, 8).join(' | '))
    step('create', 'failed')
    return report
  }

  // ── 6. archive the source, last ──────────────────────────────────────────
  // An automatic handoff may be asked to leave the source visible: a session that
  // broke while the owner was away is evidence, and hiding it before they can look
  // is the wrong default for an unattended action.
  if (input.archive === false) {
    step('archive', 'skipped (the caller asked to keep the source visible)')
  } else try {
    await archiveSession(ctx, session.id)
    report.archived = true
    step('archive', session.id + ' (work stopped)')
  } catch (error) {
    report.warnings.push('successor created but archiving the source failed: ' + String((error && error.message) || error))
    step('archive', 'failed')
  }

  // ── 7. release the source's live event tree ──────────────────────────────
  // Archiving hides the session; it does NOT free memory. These are two independent
  // concerns, so this step does not depend on the archive step: a handoff that keeps
  // the source visible (the automatic default) must still drop its live event tree,
  // or a very large session would stay resident forever.
  //
  // The durable log is untouched either way, so the session stays readable and can be
  // reopened from disk at any time.
  {
    const released = releaseLiveSession(ctx, session.id)
    report.released = released.released
    if (released.released) step('release', 'live event tree dropped for ' + session.id)
    else step('release', 'kept live (' + released.reason + ')')
  }

  report.ok = true
  return report
}

/**
 * Resolve the provider/model and window a summarization request should use.
 *
 * The live request header is the authority: it records what this session
 * actually routes to, including any per-session override.
 *
 * @param {object} agent - the source agent.
 * @param {object} session - the source session.
 * @returns {{provider: string, model: string, modelWindow: number}|undefined} the target.
 */
export function resolveTarget(agent, session) {
  let header
  try { header = session.requestHeader() } catch { header = undefined }
  const config = (header && header.config) || {}
  const options = (agent && agent.options) || {}
  const provider = pickString(config.provider, options.provider)
  const model = pickString(config.model, options.model)
  if (provider === undefined || model === undefined) return undefined
  // The live request header is the authority for the window too: it records what
  // this session actually routes to, including any per-session override. Agent
  // options carry no window of their own, so the session header is the fallback.
  const sessionHeader = (session && session.header) || {}
  const modelWindow = pickNumber(
    config.contextWindow,
    sessionHeader.contextWindow,
    options.contextWindow,
    128000,
  )
  return { provider, model, modelWindow }
}

/**
 * @param {...unknown} values - candidates.
 * @returns {string|undefined} the first non-empty string.
 */
function pickString(...values) {
  for (const value of values) if (typeof value === 'string' && value.length > 0) return value
  return undefined
}

/**
 * @param {...unknown} values - candidates.
 * @returns {number|undefined} the first positive finite number.
 */
function pickNumber(...values) {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value
  }
  return undefined
}

/**
 * Wrap the assembled memory in the framing the successor needs to act on it.
 *
 * @param {string} body - the assembled layers.
 * @param {object} session - the source session.
 * @param {object} report - the in-progress report.
 * @returns {string} the complete seed text.
 */
function wrapSeed(body, session, report) {
  const header = [
    '# Handoff from session `' + session.id + '`',
    '',
    'This session was handed off by the `' + HANDOFF_MARKER + '` plugin because it grew too large to keep working in.',
    'The work is unchanged. Continue it from here. The source session was archived and stays readable in the sidebar if you need to check something verbatim.',
    '',
    'Carried over: ' + report.facts + ' extracted facts, ' + report.checkpoints + ' earlier checkpoint(s), ' + report.summaryChars + ' characters of narrative summary.',
    '',
    '---',
    '',
  ].join('\n')
  const trimmed = body.trim()
  const footer = trimmed.length === 0
    ? '_No memory could be extracted from the source session. Ask the user what to do next._'
    : trimmed
  return header + footer
}

/**
 * Create the successor session and deliver the seed as its opening turn.
 *
 * @param {{ctx: object, session: object, seedText: string, request?: object}} input - services, source session, seed.
 * @returns {Promise<string>} the new session id.
 */
async function createSuccessor(input) {
  const ctx = input.ctx
  const session = input.session
  const newSessionId = 'session-' + randomUUID()
  const header = session.header || {}
  // The successor must be able to answer its own first turn, which means it needs
  // the route the source was actually using. Without this the seed arrives and the
  // turn fails with "has no provider/model".
  const target = resolveTarget({ options: {} }, session)
  await ctx.agents.create({
    sessionId: newSessionId,
    meta: {
      ...(header.cwd === undefined ? {} : { cwd: header.cwd }),
      ...(header.agentPreset === undefined ? {} : { agentPreset: header.agentPreset }),
      parentSession: session.id,
    },
    ...(target === undefined ? {} : { agentOptions: { provider: target.provider, model: target.model } }),
  })
  await promptSession(ctx, newSessionId, input.seedText, input.request)
  await attachToWorkspace(ctx, header.cwd, newSessionId)
  return newSessionId
}

/**
 * Send one message to a session through the session controller.
 *
 * Falls back to the live agent's inbox when the controller is unavailable, so the
 * seed is never silently lost.
 *
 * @param {object} ctx - plugin context.
 * @param {string} sessionId - the target session.
 * @param {string} text - the message body.
 * @param {object} request - the originating command invocation.
 */
async function promptSession(ctx, sessionId, text, request) {
  const content = [{ type: 'text', text }]
  const controller = ctx.get('sessionController')
  if (controller !== undefined && typeof controller.prompt === 'function') {
    // The controller's signature is prompt(request, signal) and it calls
    // signal.throwIfAborted() before admitting anything, so a signal is required
    // even when the caller has no cancellation to forward.
    const signal = (request && request.signal) || new AbortController().signal
    await controller.prompt({
      requestId: 'handoff-' + randomUUID(),
      sessionId,
      mode: 'queue',
      content,
      ...(request && typeof request.clientTimeZone === 'string' ? { clientTimeZone: request.clientTimeZone } : {}),
    }, signal)
    return
  }
  const agent = ctx.agents.get(sessionId)
  if (agent === undefined) throw new Error('the successor session has no live agent to receive the seed')
  agent.followup({ content, source: { kind: 'plugin', plugin: HANDOFF_MARKER } })
}

/**
 * Attach the successor to the workspace that owns the source's directory.
 *
 * Best effort: a session outside any workspace still works, it is just not
 * grouped in the sidebar.
 *
 * @param {object} ctx - plugin context.
 * @param {string|undefined} cwd - the source working directory.
 * @param {string} sessionId - the successor.
 */
async function attachToWorkspace(ctx, cwd, sessionId) {
  const registry = ctx.get('workspaceRegistry')
  if (registry === undefined || cwd === undefined) return
  try {
    const workspace = typeof registry.resolveByPath === 'function' ? await registry.resolveByPath(cwd) : undefined
    if (workspace !== undefined && typeof workspace.attachSession === 'function') await workspace.attachSession(sessionId)
  } catch {
    // Grouping is cosmetic; never fail a handoff over it.
  }
}

/**
 * Archive one session through the workspace registry.
 *
 * @param {object} ctx - plugin context.
 * @param {string} sessionId - the session to archive.
 */
async function archiveSession(ctx, sessionId) {
  const registry = ctx.get('workspaceRegistry')
  if (registry === undefined || typeof registry.archiveSession !== 'function') {
    throw new Error('the workspace registry is unavailable, so the source cannot be archived')
  }
  // stopActivity makes the archive terminate the session's own work first: the
  // registry asks every workspace/session-stop provider, and the agent provider
  // cancels the running turn exactly the way the user's own stop button does.
  // Without it, archiving a session that is mid-turn is refused outright.
  await registry.archiveSession(sessionId, { stopActivity: true })
}

/**
 * Release one session's live event tree.
 *
 * Archiving only hides a session from the sidebar; it does not free memory. The
 * live tree is held by the session store, and a very large session is exactly the
 * case where that matters. `SessionStore.remove(id)` runs the store's official
 * detach lifecycle, so the session is dropped from the live set while its durable
 * log stays on disk and it remains readable.
 *
 * Best effort by design: the session must not be running (the archive step already
 * stopped it), and a store that refuses the removal leaves the handoff successful
 * with a reported warning rather than failing it.
 *
 * @param {object} ctx - plugin context.
 * @param {string} sessionId - the session whose live tree to release.
 * @returns {{released: boolean, reason?: string}} the outcome.
 */
export function releaseLiveSession(ctx, sessionId) {
  const sessions = ctx.get('sessions')
  if (sessions === undefined) return { released: false, reason: 'the session store is unavailable' }
  if (typeof sessions.remove !== 'function') return { released: false, reason: 'this build exposes no session removal' }
  try {
    // Refuse to drop a session whose own agent is still working: removing it then
    // would race the driver's closing events.
    const agent = ctx.get('agents')?.get?.(sessionId)
    if (agent !== undefined && agent.status === 'running') {
      return { released: false, reason: 'the session was still running' }
    }
    return sessions.remove(sessionId)
      ? { released: true }
      : { released: false, reason: 'the session was not live in the store' }
  } catch (error) {
    return { released: false, reason: String((error && error.message) || error) }
  }
}

/**
 * Render a handoff report for the command reply.
 *
 * @param {object} report - the structured report.
 * @returns {string} Markdown text.
 */
export function renderReport(report) {
  if (report === undefined) return 'handoff produced no report.'
  const lines = []
  lines.push(report.ok
    ? 'Handed off `' + report.sourceSessionId + '` to `' + report.newSessionId + '`.'
    : 'Handoff did not complete.')
  lines.push('')
  for (const entry of report.steps || []) lines.push('- ' + entry.name + ': ' + (entry.detail || 'ok'))
  if (Array.isArray(report.warnings) && report.warnings.length > 0) {
    lines.push('', 'Warnings:')
    for (const warning of report.warnings) lines.push('- ' + warning)
  }
  if (report.archived) {
    lines.push('', 'The source session is archived; it stays readable in the sidebar.')
    if (report.released) lines.push('Its live event tree was released, so it no longer occupies memory.')
  }
  else if (report.newSessionId !== null) lines.push('', 'The source session was **not** archived, so you can keep using it until you are satisfied with the successor.')
  return lines.join('\n')
}
