#!/usr/bin/env node
/**
 * Replay a REAL compaction-failure sequence through the mounted plugin and report
 * exactly when the automatic handoff fires.
 *
 * The sequence comes from a real 106MB session that hit the 11133 deadlock: 1,316
 * compaction failures, of which 1,303 were policy refusals and the rest were terminal.
 * Replaying it is how the JOINT condition is verified against reality rather than
 * against a guess: a refusal storm alone must not tear down a working session, while a
 * terminal failure must fire regardless of size.
 *
 * The 18MB session log itself is not committed (it is private conversation content);
 * regenerate the small sequence file with tests/make-fixture.mjs.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import * as entry from 'file:///D:/WishProject/dsh-session-handoff/lib/index.js'

const RESULT = 'D:/WishProject/dsh-session-handoff/_auto-trigger-result.txt'
const SEQ_PATH = 'D:/WishProject/dsh-session-handoff/tests/fixtures/compaction-sequence.json'

if (!existsSync(SEQ_PATH)) {
  writeFileSync(RESULT, 'SKIPPED: the real-session fixture is absent. Regenerate it with tests/make-fixture.mjs.\n')
  process.exit(0)
}
const seq = JSON.parse(readFileSync(SEQ_PATH, 'utf8'))

/**
 * Mount the plugin against a stub host and capture every auto-handoff attempt.
 *
 * The plugin logs through console.log, and its handler continues asynchronously (it
 * waits for the driver to settle), so the capture channel stays open for the whole
 * drive and is closed only by the returned \`restore\`.
 */
function mount(tokens) {
  const handlers = {}
  const attempts = []
  const ctx = {
    ...hostStub(tokens),
    effect: (fn) => { const gen = fn(); let step = gen.next(); while (!step.done) step = gen.next(); return () => {} },
    on: (name, fn) => { (handlers[name] = handlers[name] || []).push(fn); return () => {} },
    commands: { register: () => () => {} },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  }
  const originalLog = console.log
  const originalError = console.error
  console.log = (...args) => {
    const line = args.map(String).join(' ')
    if (line.includes('auto-handoff firing')) attempts.push(line)
  }
  console.error = () => {}
  entry.apply(ctx, { autoHandoff: { enabled: true, atLevel: 'critical' } })
  return {
    handlers,
    attempts,
    restore: () => { console.log = originalLog; console.error = originalError },
  }
}

const created = []
const prompted = []
const session = {
  id: 'session-real',
  header: { cwd: 'D:\\\\WishProject\\\\dsh-session-handoff' },
  requestHeader: () => ({ config: { provider: 'ai', model: 'deepseek-v4.1-flash', contextWindow: 1000000 } }),
  deriveMessages: () => [{ role: 'user', content: [{ type: 'text', text: 'work in progress' }] }],
  snapshotEvents: () => [],
}
// \`idle\` so the wait-for-idle path returns immediately; the suite covers the busy case.
const agent = { session, status: 'idle', options: {}, inject: () => {} }

/** Enough of the host to let a handoff COMPLETE, so one fire stays one fire. */
function hostStub(tokens) {
  return {
    llm: {
      stream: async function* () {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: 'Summary of the work so far.' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Summary of the work so far.' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
    agents: {
      create: async (options) => { created.push(options); return {} },
      get: () => agent,
    },
    tokenMeter: { measure: () => ({ totalTokens: tokens }) },
    // The plugin prefers the harness's own contextPressure projection, which is the
    // PROVIDER-REPORTED occupancy. Supplying it here keeps the replay exercising the
    // real path; without it every reading is an estimate and the gate blocks it.
    sessionProjections: {
      stateOf: (session, key) => (key === 'contextPressure'
        ? { pressureTokens: tokens, projectedTokens: tokens, contextWindow: 1000000 }
        : undefined),
    },
    get(name) {
      if (name === 'agents') return this.agents
      if (name === 'sessionProjections') return this.sessionProjections
      if (name === 'workspaceRegistry') return { archiveSession: async () => {}, resolveByPath: async () => undefined }
      if (name === 'sessionController') {
        return { prompt: async (request, signal) => { signal.throwIfAborted(); prompted.push(request) } }
      }
      return undefined
    },
  }
}

/** Deliver one durable event to every watcher, as the real store does. */
const drive = (handlers, event) => {
  for (const fn of handlers['session/event'] ?? []) fn(session, event)
}
/**
 * Let the handler's async continuation run. The stub agent is already idle, so the
 * wait-for-idle path returns on its first tick — one macrotask is enough, and settling
 * after every event keeps each fire attributed to the event that caused it.
 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 5))
const refusal = (code) => ({ type: 'compaction/end', data: { error: '403: {"code":"' + (code ?? 'other') + '"}' } })

const results = []

for (const [label, tokens] of [['SMALL session (10% of window)', 100000], ['LARGE session (90% of window)', 900000]]) {
  const mounted = mount(tokens)
  let firstFireAt = -1
  for (let i = 0; i < seq.length; i += 1) {
    drive(mounted.handlers, refusal(seq[i].code))
    await settle()
    if (firstFireAt < 0 && mounted.attempts.length > 0) firstFireAt = i
  }
  await settle()
  mounted.restore()
  const at = firstFireAt < 0 ? 'never' : 'failure #' + String(firstFireAt + 1)
  const code = firstFireAt < 0 ? '' : ' (' + (seq[firstFireAt].code ?? 'other') + ')'
  results.push(label + ': fired at ' + at + code + ', attempts=' + mounted.attempts.length)
}

// A successful compaction must reset the streak, so two failures either side of one
// success never reach the threshold.
const reset = mount(900000)
drive(reset.handlers, refusal('dsh_compaction_refused'))
drive(reset.handlers, refusal('dsh_compaction_refused'))
drive(reset.handlers, { type: 'compaction/end', data: {} })
drive(reset.handlers, refusal('dsh_compaction_refused'))
drive(reset.handlers, refusal('dsh_compaction_refused'))
await settle()
reset.restore()
results.push('after a success reset: attempts=' + reset.attempts.length + ' (expected 0 — a success restarts the streak)')

writeFileSync(RESULT, results.join('\n') + '\n')
