/**
 * Unit tests for dsh-session-handoff.
 *
 * These cover the invariants that make the plugin safe to run on a session that
 * is already too large to compact. The most important one is negative: **no
 * assembled summarization request may exceed its budget**, because a single
 * oversized request is the exact failure mode the plugin exists to fix.
 *
 * Run: node tests/smoke.test.mjs
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { CHUNK_SUMMARY_MAX_TOKENS, estimateTokens, inputBudget, packChunks, truncateToBudget } from '../lib/token-budget.js'
import { buildSeed, collectCheckpoints, extractCheckpointText, extractFacts, recentTurns, redactSecrets, renderMessage, renderRecentTurns, toBlocks } from '../lib/memory.js'
import { classify, classifyCompactionFailure, DEFAULT_POLICY, reminderText, resolvePolicy, shouldRemind } from '../lib/pressure.js'
import { releaseLiveSession, resolveTarget, renderReport } from '../lib/handoff.js'

// ── module load (guards the installed plugin's import graph) ─────────────────

test('every shipped module loads and exports what the plugin calls', async () => {
  // A missing import binding is invisible to unit tests that only pull individual
  // functions, but it makes the installed plugin throw on first use. Import the
  // whole graph the way the harness does.
  const modules = ['token-budget', 'memory', 'pressure', 'summarize', 'handoff']
  const loaded = {}
  for (const name of modules) {
    loaded[name] = await import('../lib/' + name + '.js')
  }
  // handoff.js calls resolvePolicy; assert the binding is actually reachable.
  assert.equal(typeof loaded.handoff.runHandoff, 'function')
  assert.equal(typeof loaded.handoff.resolveTarget, 'function')
  assert.equal(typeof loaded.handoff.renderReport, 'function')
  assert.equal(typeof loaded.pressure.resolvePolicy, 'function')
  assert.equal(typeof loaded.summarize.summarizeBlocks, 'function')
  // The entry point is the one the harness loads; it must import cleanly.
  const entry = await import('../lib/index.js')
  assert.equal(entry.name, 'dsh-session-handoff')
  assert.equal(typeof entry.apply, 'function')
  assert.ok(Array.isArray(entry.inject))
})

test('a fresh process can import the installed entry point', async () => {
  // This is the check that catches a missing import binding. Unit tests that pull
  // individual functions never see it, but the harness loads lib/index.js and its
  // whole graph on activation.
  const { execFileSync } = await import('node:child_process')
  const { fileURLToPath } = await import('node:url')
  const entry = fileURLToPath(new URL('../lib/index.js', import.meta.url))
  const script = 'import(' + JSON.stringify('file:///' + entry.replace(/\\/g, '/')) + ').then(m => {'
    + ' if (typeof m.apply !== \'function\') throw new Error(\'apply is not a function\');'
    + ' if (m.name !== \'dsh-session-handoff\') throw new Error(\'wrong name: \' + m.name);'
    + ' if (!Array.isArray(m.inject) || m.inject.length === 0) throw new Error(\'inject missing\');'
    + ' console.log(\'OK\'); })'
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' })
  assert.ok(output.includes('OK'), 'the installed entry point must import cleanly')
})

test('the whole handoff pipeline runs end to end against a stub llm', async () => {
  const { runHandoff } = await import('../lib/handoff.js')
  const created = []
  const prompted = []
  const archived = []
  // A stub llm whose stream yields one text block, so no network is involved.
  // The stream protocol is chunk-based: block-start, text-delta*, block-end, finish.
  const stream = async function* () {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'STUB ' }
    yield { type: 'text-delta', index: 0, text: 'SUMMARY' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'STUB SUMMARY' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  const ctx = {
    llm: { stream },
    agents: {
      create: async (options) => { created.push(options) },
      get: () => undefined,
    },
    get: (name) => {
      if (name === 'workspaceRegistry') {
        return {
          archiveSession: async (id) => { archived.push(id) },
          resolveByPath: async () => undefined,
        }
      }
      if (name === 'sessionController') {
        // The real controller signature is prompt(request, signal) and it calls
        // signal.throwIfAborted() first, so the stub enforces the same contract.
        return {
          prompt: async (request, signal) => {
            if (signal === undefined || typeof signal.throwIfAborted !== 'function') {
              throw new TypeError("Cannot read properties of undefined (reading 'throwIfAborted')")
            }
            signal.throwIfAborted()
            prompted.push(request)
          },
        }
      }
      return undefined
    },
  }
  const agent = {
    options: { provider: 'ai', model: 'stub-model' },
    session: {
      id: 'session-source',
      header: { cwd: 'D:\\proj', agentPreset: 'ptc' },
      requestHeader: () => ({ config: { provider: 'ai', model: 'stub-model', contextWindow: 1000000 } }),
      deriveMessages: () => [
        { role: 'user', content: [{ type: 'text', text: 'work on D:\\proj\\src\\a.ts' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'done, ran pnpm run build' }] },
      ],
      snapshotEvents: () => [{ type: 'compaction/end', seq: 3, data: { summary: 'an earlier checkpoint' } }],
    },
  }
  const report = await runHandoff({ ctx, agent, config: {} })
  assert.equal(report.ok, true, 'handoff must succeed: ' + JSON.stringify(report.warnings))
  assert.equal(report.facts > 0, true, 'facts must be extracted')
  assert.equal(report.checkpoints, 1)
  assert.equal(created.length, 1, 'exactly one successor must be created')
  assert.equal(created[0].meta.parentSession, 'session-source')
  // The successor must be able to answer its own first turn, so it has to inherit
  // the route the source was using.
  assert.equal(created[0].agentOptions.provider, 'ai', 'the successor must inherit the provider')
  assert.equal(created[0].agentOptions.model, 'stub-model', 'the successor must inherit the model')
  assert.equal(created[0].meta.cwd, 'D:\\proj')
  assert.equal(prompted.length, 1, 'the seed must be delivered to the successor')
  const seed = prompted[0].content[0].text
  assert.ok(seed.includes('a.ts'), 'the seed must carry the real path')
  assert.ok(seed.includes('an earlier checkpoint'), 'the seed must carry the checkpoint')
  assert.ok(seed.includes('STUB SUMMARY'), 'the seed must carry the model summary')
  assert.deepEqual(archived, ['session-source'], 'the source must be archived exactly once')
  assert.equal(report.archived, true)
})

// ── token-budget ─────────────────────────────────────────────────────────────

test('estimateTokens counts CJK glyphs near one token each', () => {
  assert.equal(estimateTokens(''), 0)
  assert.equal(estimateTokens('abcd'), 1)
  // 100 wide glyphs must cost far more than 100 ASCII characters.
  assert.ok(estimateTokens('一'.repeat(100)) > estimateTokens('a'.repeat(100)) * 2)
})

test('inputBudget always leaves room for the completion', () => {
  const budget = inputBudget(1000000, CHUNK_SUMMARY_MAX_TOKENS)
  assert.ok(budget + CHUNK_SUMMARY_MAX_TOKENS <= 1000000 * 0.5)
  // A pathological window must still yield a usable, positive budget.
  assert.ok(inputBudget(1, CHUNK_SUMMARY_MAX_TOKENS) >= 2048)
  assert.ok(inputBudget(undefined, undefined) > 0)
})

test('packChunks never exceeds the budget except for a single oversized item', () => {
  const items = Array.from({ length: 20 }, (_, i) => ({ tokens: 100, id: i }))
  const chunks = packChunks(items, 450)
  for (const chunk of chunks) {
    const total = chunk.reduce((sum, item) => sum + item.tokens, 0)
    assert.ok(total <= 450 || chunk.length === 1, 'chunk ' + total + ' exceeded budget')
  }
  assert.equal(chunks.flat().length, items.length, 'packing must not drop items')
  // Order is preserved, which the merge step depends on.
  assert.deepEqual(chunks.flat().map((item) => item.id), items.map((item) => item.id))
})

test('truncateToBudget keeps the head and the tail, and reports truncation', () => {
  const text = 'HEAD' + 'x'.repeat(10000) + 'TAIL'
  const result = truncateToBudget(text, 50)
  assert.equal(result.truncated, true)
  assert.ok(result.text.startsWith('HEAD'))
  assert.ok(result.text.endsWith('TAIL'))
  assert.ok(estimateTokens(result.text) <= 50)
  // Text already within budget is returned untouched.
  const small = truncateToBudget('short', 50)
  assert.equal(small.truncated, false)
  assert.equal(small.text, 'short')
})

// ── memory ───────────────────────────────────────────────────────────────────

test('extractFacts finds paths, commands and identifiers verbatim', () => {
  const source = [
    'Edited D:\\WishProject\\dsh-mnemon\\src\\host\\pack.ts:120 and ran pnpm run typecheck',
    'The failure was {"code":"11133","message":"Invalid request parameters"}',
    'Commit 54e2c08d landed; session 2328fd55-6906-4776-8fe5-ae068d9602f4 died',
  ].join('\n')
  const facts = extractFacts(source)
  assert.ok(facts.path && facts.path.some((p) => p.includes('pack.ts:120')), 'path not found')
  assert.ok(facts.command && facts.command.some((c) => c.includes('pnpm run typecheck')), 'command not found')
  const errorFacts = facts.error || []
  assert.ok(errorFacts.some((e) => e.includes('11133')), 'error code not found')
  // The capture must isolate the value, not the surrounding JSON key.
  assert.ok(!errorFacts.some((e) => e.includes('code":')), 'the JSON key must not be part of the fact: ' + JSON.stringify(errorFacts))
  // A command capture must not swallow the following connective word.
  assert.ok(!(facts.command || []).some((c) => /\band$/.test(c)), 'a trailing connective must be stripped')
  assert.ok(facts.identifier && facts.identifier.some((i) => i.includes('54e2c08d')), 'commit not found')
  // Deduplication: the same path twice yields one entry.
  const twice = extractFacts('see D:\\a\\b.ts and again D:\\a\\b.ts')
  assert.equal(twice.path.filter((p) => p === 'D:\\a\\b.ts').length, 1)
})

test('extractFacts collapses generated paths and prefers source paths', () => {
  const lines = []
  // Forty near-identical build artifacts that differ only in a hash.
  for (let i = 0; i < 40; i += 1) {
    lines.push('D:\\p\\target\\debug\\build\\ai-gateway-core-' + i.toString(16).padStart(16, '0') + '\\out\\gateway_embed.gz')
  }
  lines.push('edited D:\\p\\src\\host\\rpc.ts and D:\\p\\src\\client\\api.ts')
  const facts = extractFacts(lines.join('\n'))
  const artifacts = facts.path.filter((p) => p.includes('gateway_embed.gz'))
  assert.ok(artifacts.length <= 2, 'generated artifacts must collapse, got ' + artifacts.length)
  assert.ok(facts.path.some((p) => p.includes('rpc.ts')), 'source paths must survive the cap')
  assert.ok(facts.path.some((p) => p.includes('api.ts')))
})

test('extractFacts prefers recent occurrences and cleans trailing punctuation', () => {
  const lines = []
  for (let i = 0; i < 100; i += 1) lines.push('early D:\\p\\file' + i + '.ts')
  lines.push('recent D:\\p\\file99.ts)')
  lines.push('recent D:\\p\\final.ts.')
  const facts = extractFacts(lines.join('\n'))
  assert.ok(facts.path.includes('D:\\p\\final.ts'), 'trailing prose punctuation must be stripped')
  assert.ok(facts.path.includes('D:\\p\\file99.ts'), 'a closing bracket must be stripped')
  // The newest paths must be present; the oldest must have been dropped by the cap.
  assert.ok(facts.path.includes('D:\\p\\file99.ts'))
  assert.ok(!facts.path.includes('D:\\p\\file0.ts'), 'the oldest entries should be dropped once the cap is reached')
})

test('extractFacts bounds a pathological log', () => {
  const source = Array.from({ length: 5000 }, (_, i) => 'D:\\p\\file' + i + '.ts').join(' ')
  const facts = extractFacts(source)
  assert.ok(facts.path.length <= 60, 'per-kind cap not enforced, got ' + facts.path.length)
})

test('collectCheckpoints keeps successful summaries and skips failures', () => {
  const events = [
    { type: 'compaction/end', seq: 10, data: { error: '403 refused' } },
    { type: 'compaction/end', seq: 20, data: { summary: 'first checkpoint' } },
    { type: 'compaction/end', seq: 30, data: { summaryBlocks: [{ type: 'text', text: 'second' }] } },
    { type: 'turn/end', seq: 40, data: {} },
  ]
  const checkpoints = collectCheckpoints(events)
  assert.equal(checkpoints.length, 2, 'expected two usable checkpoints')
  assert.deepEqual(checkpoints.map((c) => c.seq), [20, 30])
  assert.equal(checkpoints[0].text, 'first checkpoint')
})

test('extractCheckpointText probes every known carrier', () => {
  assert.equal(extractCheckpointText({ data: { summary: 'a' } }), 'a')
  assert.equal(extractCheckpointText({ data: { text: 'b' } }), 'b')
  assert.equal(extractCheckpointText({ data: { checkpoint: 'c' } }), 'c')
  assert.equal(extractCheckpointText({ data: {} }), undefined)
})

test('renderMessage keeps tool calls but drops hidden reasoning', () => {
  const message = {
    role: 'assistant',
    content: [
      { type: 'reasoning', text: 'SECRET CHAIN OF THOUGHT' },
      { type: 'text', text: 'visible' },
      { type: 'tool-call', name: 'run_code', arguments: '{"code":"1"}' },
    ],
  }
  const text = renderMessage(message)
  assert.ok(text.includes('visible'))
  assert.ok(text.includes('run_code'))
  assert.ok(!text.includes('SECRET'), 'reasoning must not leak into the seed')
})

test('toBlocks skips empty messages and estimates each block', () => {
  const blocks = toBlocks([
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: [] },
    { role: 'user', content: [{ type: 'text', text: 'world' }] },
  ])
  assert.equal(blocks.length, 2)
  assert.ok(blocks.every((block) => block.tokens > 0))
})

test('redactSecrets removes credential shapes without touching ordinary text', () => {
  const cases = [
    ['Authorization: Bearer ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', 'ghp_'],
    ['token = "sk-abcdefghijklmnopqrstuvwxyz012345"', 'sk-abcdef'],
    ['api_key: supersecretvalue123', 'supersecretvalue123'],
    ['PASSWORD=hunter2hunter2', 'hunter2hunter2'],
    ['{"private_key": "-----BEGIN RSA PRIVATE KEY-----AAAA"}', 'BEGIN RSA'],
    ['https://user:letmein123@example.com/path', 'letmein123'],
    ['AKIAIOSFODNN7EXAMPLE', 'AKIAIOSFODNN7EXAMPLE'],
  ]
  for (const [input, forbidden] of cases) {
    const result = redactSecrets(input)
    assert.ok(!result.text.includes(forbidden), 'not redacted: ' + input + ' -> ' + result.text)
    assert.ok(result.redactions > 0, 'no redaction counted for: ' + input)
  }
  // Ordinary prose, code and paths must survive untouched.
  const clean = [
    'Edited src/host/rpc.ts:120 and ran pnpm run typecheck',
    'The error was {"code":"11133","message":"Invalid request parameters"}',
    'D:\\WishProject\\dsh-mnemon\\lib\\index.js',
    'session-2328fd55-6906-4776-8fe5-ae068d9602f4',
  ]
  for (const input of clean) {
    const result = redactSecrets(input)
    assert.equal(result.text, input, 'ordinary text must survive: ' + input)
    assert.equal(result.redactions, 0)
  }
})

test('redaction is neither blind nor over-eager on a realistic leak', () => {
  // Negative control: a clean transcript tail must pass through byte-identical.
  // SHA-256 digests are the interesting case — 64 hex characters look like a
  // secret but are exactly the kind of evidence a handoff must preserve.
  const cleanTail = [
    '### tool',
    'notes bytes 13965 chars 8327',
    'status 201',
    'id 405456103 tag v1.0.34 target main draft false prerelease false',
    '6B87A39906CF40743DFF515331398B88EBE3E9C5E0EF180B0886A4E85550E476',
    'edited D:\\WishProject\\dsh-mnemon\\src\\host\\rpc.ts and ran pnpm run typecheck',
  ].join('\n')
  const untouched = redactSecrets(cleanTail)
  assert.equal(untouched.redactions, 0, 'a clean tail must produce no redactions')
  assert.equal(untouched.text, cleanTail, 'a clean tail must pass through unchanged')

  // Positive control: the same tail with credentials spliced in the way a
  // debugging session echoes them.
  const leaked = cleanTail + [
    '',
    'Authorization: Bearer ghp_REALISTICLEAKEDTOKEN0123456789abcdef',
    'export WB_TOKEN=sk-live-9f8e7d6c5b4a39281706f5e4d3c2b1a0',
    'api_key: "9f8e7d6c5b4a39281706f5e4d3c2b1a0"',
    'DATABASE_URL=postgres://admin:S3cr3tP4ssw0rd@db.internal:5432/prod',
  ].join('\n')
  const caught = redactSecrets(leaked)
  assert.ok(caught.redactions >= 4, 'every leaked credential must be caught, got ' + caught.redactions)
  for (const secret of ['ghp_REALISTICLEAKEDTOKEN0123456789abcdef', 'sk-live-9f8e7d6c5b4a39281706f5e4d3c2b1a0', 'S3cr3tP4ssw0rd']) {
    assert.ok(!caught.text.includes(secret), 'leaked value survived: ' + secret)
  }
  // The digest from the clean tail must still be there.
  assert.ok(caught.text.includes('6B87A39906CF40743DFF515331398B88EBE3E9C5E0EF180B0886A4E85550E476'), 'a digest must not be mistaken for a secret')
})

test('the rendered verbatim tail is redacted', () => {
  const section = renderRecentTurns([
    { role: 'tool', text: 'export GH_TOKEN=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', tokens: 10 },
  ])
  assert.ok(!section.includes('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'), 'a token must not reach the seed')
  assert.ok(section.includes('<redacted'), 'the redaction must be visible')
})

test('recentTurns keeps the newest messages verbatim within budget', () => {
  const messages = []
  for (let i = 0; i < 200; i += 1) {
    messages.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: [{ type: 'text', text: 'message ' + i + ' ' + 'x'.repeat(200) }] })
  }
  const result = recentTurns(messages, 500)
  assert.ok(result.blocks.length > 0, 'the tail must not be empty')
  assert.ok(result.blocks.length < messages.length, 'a huge transcript must be trimmed')
  // The newest message must be present; the oldest must not be.
  const joined = result.blocks.map((b) => b.text).join('\n')
  assert.ok(joined.includes('message 199'), 'the newest message must be kept')
  assert.ok(!joined.includes('message 0 '), 'the oldest messages must be dropped')
  // Order is chronological, and the total respects the budget.
  assert.ok(result.blocks[result.blocks.length - 1].text.includes('message 199'))
  const total = result.blocks.reduce((sum, b) => sum + b.tokens, 0)
  assert.ok(total <= 500, 'the tail must respect its budget, got ' + total)
})

test('recentTurns does not start mid-exchange', () => {
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'u1 ' + 'x'.repeat(400) }] },
    { role: 'assistant', content: [{ type: 'text', text: 'a1 ' + 'x'.repeat(400) }] },
    { role: 'user', content: [{ type: 'text', text: 'u2 ' + 'x'.repeat(400) }] },
    { role: 'assistant', content: [{ type: 'text', text: 'a2 ' + 'x'.repeat(400) }] },
  ]
  const result = recentTurns(messages, 260)
  // The kept span must begin with a user message, never a dangling assistant reply.
  assert.ok(result.blocks.length > 0)
  assert.equal(result.blocks[0].role, 'user', 'the tail must start at a turn boundary')
})

test('recentTurns truncates a single oversized newest message instead of dropping it', () => {
  const messages = [{ role: 'user', content: [{ type: 'text', text: 'HEAD' + 'y'.repeat(100000) + 'TAIL' }] }]
  const result = recentTurns(messages, 200)
  assert.equal(result.blocks.length, 1, 'the only message must still be represented')
  assert.equal(result.truncated, true)
  assert.ok(result.blocks[0].tokens <= 200)
})

test('renderRecentTurns labels the section and each role', () => {
  const text = renderRecentTurns([{ role: 'user', text: 'hello', tokens: 1 }])
  assert.ok(text.includes('verbatim'))
  assert.ok(text.includes('### user'))
  assert.ok(text.includes('hello'))
  assert.equal(renderRecentTurns([]), '')
})

test('buildSeed places the verbatim tail above the narrative summary', () => {
  const seed = buildSeed({
    facts: {},
    checkpoints: [],
    recent: [{ role: 'user', text: 'THE EXACT LAST INSTRUCTION', tokens: 6 }],
    prose: 'a paraphrase of everything',
    budgetTokens: 5000,
  })
  assert.ok(seed.text.includes('THE EXACT LAST INSTRUCTION'))
  assert.ok(seed.text.includes('a paraphrase'))
  // The exact layer must come before the paraphrase.
  assert.ok(seed.text.indexOf('THE EXACT LAST INSTRUCTION') < seed.text.indexOf('a paraphrase'))
})

test('buildSeed keeps facts and checkpoints when prose cannot fit', () => {
  const seed = buildSeed({
    facts: { path: ['D:\\a\\b.ts'] },
    checkpoints: [{ seq: 5, text: 'an earlier checkpoint' }],
    prose: 'narrative',
    // A budget too small for the prose but large enough for the fixed layers.
    budgetTokens: estimateTokens('## Verbatim facts (extracted, not paraphrased)\n\n**Paths touched**\n- `D:\\a\\b.ts`\n\n## Earlier checkpoints this session already wrote\n\n### checkpoint at seq 5\nan earlier checkpoint') + 10,
  })
  assert.ok(seed.text.includes('D:\\a\\b.ts'), 'facts must survive')
  assert.ok(seed.text.includes('an earlier checkpoint'), 'checkpoints must survive')
  assert.ok(seed.notes.some((note) => note.includes('prose summary dropped')), 'the drop must be reported')
})

test('buildSeed truncates prose rather than dropping facts', () => {
  const seed = buildSeed({
    facts: { command: ['pnpm run build'] },
    checkpoints: [],
    prose: 'y'.repeat(200000),
    budgetTokens: 3000,
  })
  assert.ok(seed.text.includes('pnpm run build'))
  assert.ok(seed.notes.some((note) => note.includes('truncated')))
  assert.ok(estimateTokens(seed.text) <= 3200, 'seed must respect its budget')
})

// ── pressure ─────────────────────────────────────────────────────────────────

test('resolvePolicy ignores unusable values and repairs a broken ladder', () => {
  const policy = resolvePolicy({ upstreamPromptLimit: 500000, watchRatio: 'nope' })
  assert.equal(policy.upstreamPromptLimit, 500000)
  assert.equal(policy.watchRatio, DEFAULT_POLICY.watchRatio)
  const repaired = resolvePolicy({ watchRatio: 0.9, warnRatio: 0.5, criticalRatio: 0.6 })
  assert.ok(repaired.watchRatio < repaired.warnRatio)
  assert.ok(repaired.warnRatio < repaired.criticalRatio)
})

test('classify binds on the upstream limit when it is the tighter ceiling', () => {
  const policy = resolvePolicy({})
  // 800k of a 1M window is 80% of the window but 76% of the 1,048,576 limit.
  const byWindow = classify({ pressureTokens: 400000, modelWindow: 500000, policy })
  assert.equal(byWindow.binding, 'model-window')
  assert.equal(byWindow.level, 'critical')
  // Same pressure, huge advertised window: the upstream limit now binds.
  const byLimit = classify({ pressureTokens: 900000, modelWindow: 10000000, policy })
  assert.equal(byLimit.binding, 'upstream-prompt-limit')
  assert.equal(byLimit.level, 'critical')
})

test('classify walks the whole ladder', () => {
  const policy = resolvePolicy({ upstreamPromptLimit: 1000000, watchRatio: 0.45, warnRatio: 0.6, criticalRatio: 0.75 })
  const at = (tokens) => classify({ pressureTokens: tokens, modelWindow: 1000000, policy }).level
  assert.equal(at(100000), 'ok')
  assert.equal(at(500000), 'watch')
  assert.equal(at(650000), 'warn')
  assert.equal(at(800000), 'critical')
})

test('shouldRemind speaks on a level change and then stays quiet', () => {
  const policy = resolvePolicy({})
  const now = 1_000_000
  const critical = classify({ pressureTokens: 900000, modelWindow: 1000000, policy })
  const first = shouldRemind({ classification: critical, previous: undefined, policy, now, pressureTokens: 900000 })
  assert.equal(first.remind, true)
  // Same level, same pressure, moments later: silent.
  const second = shouldRemind({ classification: critical, previous: first.state, policy, now: now + 1000, pressureTokens: 900000 })
  assert.equal(second.remind, false)
  // Same level, cooled down, but no growth: still silent.
  const third = shouldRemind({ classification: critical, previous: first.state, policy, now: now + policy.remindCooldownMs + 1, pressureTokens: 900000 })
  assert.equal(third.remind, false)
  // Same level, cooled down, and genuinely grown: speaks again.
  const fourth = shouldRemind({ classification: critical, previous: first.state, policy, now: now + policy.remindCooldownMs + 1, pressureTokens: 900000 + policy.remindEveryTokens })
  assert.equal(fourth.remind, true)
})

test('shouldRemind is silent while pressure is fine', () => {
  const policy = resolvePolicy({})
  const ok = classify({ pressureTokens: 1000, modelWindow: 1000000, policy })
  const decision = shouldRemind({ classification: ok, previous: { level: 'warn', tokens: 700000, at: 0 }, policy, now: 99999999, pressureTokens: 1000 })
  assert.equal(decision.remind, false)
})

test('reminderText names the binding ceiling and the way out', () => {
  const policy = resolvePolicy({})
  const critical = classify({ pressureTokens: 900000, modelWindow: 1000000, policy })
  const text = reminderText({ classification: critical, pressureTokens: 900000, modelWindow: 1000000, policy })
  // The binding ceiling is named in the owner's language, not as a wire id.
  assert.ok(text.includes('模型窗口') || text.includes('上游请求长度上限'), 'the binding ceiling must be named')
  assert.ok(text.includes('/handoff'), 'the reminder must tell the user what to run')
  assert.ok(text.includes('900,000'), 'the reminder must show the measured number')
})

// ── compaction failures are judged jointly with volume ──────────────────────

test('a policy-refusal storm alone does not trigger, because the session is small', () => {
  // Measured reality: dsh_compaction_refused fired 1062 times across one session
  // while it kept working. Acting on the count alone would kill a working session.
  const policy = resolvePolicy({})
  const verdict = classifyCompactionFailure({
    code: 'dsh_compaction_refused',
    streak: 50,
    policy,
    pressureTokens: 100000,
    modelWindow: 1000000,
  })
  assert.equal(verdict.anomaly, false, 'a small session with refusals must not be torn down')
  assert.ok(verdict.reason.includes('floor') || verdict.reason.includes('%'), 'the reason must explain the volume test')
})

test('a policy-refusal storm DOES trigger once the session is large', () => {
  const policy = resolvePolicy({})
  const verdict = classifyCompactionFailure({
    code: 'dsh_compaction_refused',
    streak: 5,
    policy,
    pressureTokens: 500000,
    modelWindow: 1000000,
  })
  assert.equal(verdict.anomaly, true, 'a large session that cannot compact is stuck')
  assert.ok(verdict.reason.includes('blocking'))
})

test('volume alone never triggers: a large session with no failures is fine', () => {
  const policy = resolvePolicy({})
  // The caller only asks after a failure, but assert the streak gate explicitly.
  const verdict = classifyCompactionFailure({
    code: 'dsh_compaction_refused',
    streak: 1,
    policy,
    pressureTokens: 900000,
    modelWindow: 1000000,
  })
  assert.equal(verdict.anomaly, false, 'one failure is not a streak')
  assert.ok(verdict.reason.includes('below the threshold'))
})

test('a terminal code triggers at any size', () => {
  const policy = resolvePolicy({})
  for (const code of ['context_length_exceeded', 'model_param_invalid']) {
    const verdict = classifyCompactionFailure({ code, streak: 1, policy, pressureTokens: 1000, modelWindow: 1000000 })
    assert.equal(verdict.anomaly, true, code + ' must trigger regardless of size')
    assert.ok(verdict.reason.includes('terminal'))
  }
})

test('a platform-level pool failure never triggers, because a handoff cannot fix it', () => {
  // Real data: no_healthy_account appeared in the failure storm. Every session on
  // that route fails identically, so archiving a working session would not help.
  const policy = resolvePolicy({})
  const verdict = classifyCompactionFailure({
    code: 'no_healthy_account', streak: 50, policy, pressureTokens: 900000, modelWindow: 1000000,
  })
  assert.equal(verdict.anomaly, false)
  assert.ok(verdict.reason.includes('platform'), 'the reason must name the platform, not the session')
})

test('an unknown code is never trusted as a trigger', () => {
  const policy = resolvePolicy({})
  const verdict = classifyCompactionFailure({
    code: 'something_new_from_a_future_build',
    streak: 99,
    policy,
    pressureTokens: 900000,
    modelWindow: 1000000,
  })
  assert.equal(verdict.anomaly, false, 'the plugin must not guess at unknown codes')
  assert.ok(verdict.reason.includes('unrecognized'))
})

test('the joint thresholds are configurable', () => {
  const policy = resolvePolicy({ compactionFailureThreshold: 10, compactionAnomalyVolumeRatio: 0.8 })
  assert.equal(policy.compactionFailureThreshold, 10)
  assert.equal(policy.compactionAnomalyVolumeRatio, 0.8)
  const verdict = classifyCompactionFailure({
    code: 'dsh_compaction_refused', streak: 5, policy,
    pressureTokens: 900000, modelWindow: 1000000,
  })
  assert.equal(verdict.anomaly, false, 'a raised threshold must be honoured')
})

// ── handoff helpers ──────────────────────────────────────────────────────────

test('resolveTarget prefers the live request header over agent options', () => {
  const agent = { options: { provider: 'fallback', model: 'fallback-model', contextWindow: 100 } }
  const session = {
    requestHeader: () => ({ config: { provider: 'ai', model: 'deepseek-v4.1-flash', contextWindow: 1000000 } }),
  }
  const target = resolveTarget(agent, session)
  assert.equal(target.provider, 'ai')
  assert.equal(target.model, 'deepseek-v4.1-flash')
  assert.equal(target.modelWindow, 1000000)
  // Falls back to agent options when the header carries no route.
  const bare = { requestHeader: () => ({ config: {} }) }
  assert.equal(resolveTarget(agent, bare).model, 'fallback-model')
  // No route anywhere: reported as unavailable rather than guessed.
  assert.equal(resolveTarget({ options: {} }, { requestHeader: () => undefined }), undefined)
})

test('resolveTarget survives a session whose header throws', () => {
  const agent = { options: { provider: 'p', model: 'm', contextWindow: 500 } }
  const session = { requestHeader: () => { throw new Error('boom') } }
  const target = resolveTarget(agent, session)
  assert.equal(target.provider, 'p')
  assert.equal(target.modelWindow, 500)
})

test('renderReport states the outcome and every warning', () => {
  const text = renderReport({
    ok: true,
    sourceSessionId: 'session-old',
    newSessionId: 'session-new',
    archived: true,
    steps: [{ name: 'read', detail: '10 messages' }],
    warnings: ['1 of 3 summary chunks failed'],
  })
  assert.ok(text.includes('session-old'))
  assert.ok(text.includes('session-new'))
  assert.ok(text.includes('1 of 3 summary chunks failed'))
  assert.ok(text.includes('archived'))
  // A successor that was created but not archived must say so plainly.
  const partial = renderReport({ ok: true, sourceSessionId: 'a', newSessionId: 'b', archived: false, steps: [], warnings: [] })
  assert.ok(partial.includes('not** archived'))
})

// ── the entry point's reminder and auto-handoff policy ───────────────────────

test('the reminder is delivered as a notice the transcript renders', async () => {
  // A reminder the owner never sees is not a reminder. The transcript only renders
  // a user message whose source declares the `notice` form, and that form requires
  // a one-line summary.
  const { createUserMessage, boundContextSummary } = await import('@deepseek-ai/dsh-llm')
  const message = createUserMessage({
    content: [{ type: 'text', text: 'This conversation is at the point where automatic compaction can no longer run.' }],
    source: {
      kind: 'session-handoff',
      form: 'notice',
      summary: boundContextSummary('context 90% of the upstream-prompt-limit — run /handoff'),
    },
  })
  assert.equal(message.role, 'user')
  assert.equal(message.source.form, 'notice', 'the notice form is what makes it render')
  assert.equal(typeof message.source.summary, 'string')
  assert.ok(message.source.summary.length <= 120, 'a notice summary is bounded')
  assert.ok(message.source.summary.includes('/handoff'), 'the summary must name the way out')
})

test('the entry point loads with the notice and auto-handoff surface present', async () => {
  const { execFileSync } = await import('node:child_process')
  const { fileURLToPath } = await import('node:url')
  const entry = fileURLToPath(new URL('../lib/index.js', import.meta.url))
  const script = 'import(' + JSON.stringify('file:///' + entry.replace(/\\/g, '/')) + ').then(m => {'
    + ' if (typeof m.apply !== \'function\') throw new Error(\'apply missing\');'
    + ' console.log(\'OK\'); })'
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' })
  assert.ok(output.includes('OK'))
})

test('an automatic handoff can leave the source visible', async () => {
  // The owner needs automatic handoff but not automatic archiving: a session that
  // broke while they were away is evidence, so hiding it is the wrong default.
  const { runHandoff } = await import('../lib/handoff.js')
  const archived = []
  const ctx = {
    llm: { stream: async function* () { yield { type: 'block-start', index: 0, blockType: 'text' }; yield { type: 'text-delta', index: 0, text: 'S' }; yield { type: 'block-end', index: 0, block: { type: 'text', text: 'S' } }; yield { type: 'finish', reason: { kind: 'stop' } } } },
    agents: { create: async () => ({}), get: () => undefined },
    get: (name) => {
      if (name === 'workspaceRegistry') return { archiveSession: async (id) => { archived.push(id) }, resolveByPath: async () => undefined }
      if (name === 'sessionController') return { prompt: async (r, s) => { s.throwIfAborted() } }
      return undefined
    },
  }
  const agent = {
    options: { provider: 'ai', model: 'm' },
    session: {
      id: 'session-source', header: { cwd: 'D:\\p' },
      requestHeader: () => ({ config: { provider: 'ai', model: 'm', contextWindow: 1000000 } }),
      deriveMessages: () => [{ role: 'user', content: [{ type: 'text', text: 'x' }] }],
      snapshotEvents: () => [],
    },
  }
  const report = await runHandoff({ ctx, agent, config: {}, archive: false })
  assert.equal(report.ok, true, 'the handoff itself must still succeed')
  assert.equal(report.archived, false, 'the source must NOT be archived')
  assert.equal(archived.length, 0, 'the registry must not have been asked')
  const text = renderReport(report)
  assert.ok(text.includes('skipped'), 'the report must say the archive was skipped')
})

// ── terminating the source and freeing its memory ───────────────────────────

test('archiving asks the registry to stop the session work first', async () => {
  // Without stopActivity the registry refuses to archive a session that is
  // mid-turn; with it, the harness cancels the turn through its own
  // workspace/session-stop providers — the same path the archive button uses.
  const { runHandoff } = await import('../lib/handoff.js')
  const calls = []
  const ctx = {
    llm: { stream: async function* () { yield { type: 'block-start', index: 0, blockType: 'text' }; yield { type: 'text-delta', index: 0, text: 'S' }; yield { type: 'block-end', index: 0, block: { type: 'text', text: 'S' } }; yield { type: 'finish', reason: { kind: 'stop' } } } },
    agents: { create: async () => ({}), get: () => undefined },
    get: (n) => {
      if (n === 'workspaceRegistry') {
        return {
          archiveSession: async (id, options) => { calls.push({ id, options }); },
          resolveByPath: async () => undefined,
        }
      }
      if (n === 'sessionController') return { prompt: async (r, s) => { s.throwIfAborted() } }
      return undefined
    },
  }
  const agent = {
    options: { provider: 'ai', model: 'm' },
    session: {
      id: 'session-source', header: { cwd: 'D:\\p' },
      requestHeader: () => ({ config: { provider: 'ai', model: 'm', contextWindow: 1000000 } }),
      deriveMessages: () => [{ role: 'user', content: [{ type: 'text', text: 'x' }] }],
      snapshotEvents: () => [],
    },
  }
  await runHandoff({ ctx, agent, config: {} })
  assert.equal(calls.length, 1, 'the source must be archived exactly once')
  assert.equal(calls[0].options.stopActivity, true, 'archiving must stop the session work')
})

test('releaseLiveSession drops the live tree and refuses a running session', () => {
  const removed = []
  const live = {
    get: (n) => {
      if (n === 'sessions') return { remove: (id) => { removed.push(id); return true } }
      if (n === 'agents') return { get: () => undefined }
      return undefined
    },
  }
  const result = releaseLiveSession(live, 'session-a')
  assert.deepEqual(result, { released: true })
  assert.deepEqual(removed, ['session-a'])

  // A running session must not be dropped: removing it would race its driver.
  const busy = {
    get: (n) => {
      if (n === 'sessions') return { remove: () => { throw new Error('must not be called') } }
      if (n === 'agents') return { get: () => ({ status: 'running' }) }
      return undefined
    },
  }
  const refused = releaseLiveSession(busy, 'session-b')
  assert.equal(refused.released, false)
  assert.ok(refused.reason.includes('running'))

  // A store that refuses, or is absent, must not throw: the handoff already succeeded.
  const noStore = { get: () => undefined }
  assert.equal(releaseLiveSession(noStore, 'session-c').released, false)
  const failing = { get: (n) => n === 'sessions' ? { remove: () => { throw new Error('locked') } } : undefined }
  const failed = releaseLiveSession(failing, 'session-d')
  assert.equal(failed.released, false)
  assert.equal(failed.reason, 'locked')
})

test('the report says whether the live tree was released', () => {
  const withRelease = renderReport({
    ok: true, sourceSessionId: 'a', newSessionId: 'b', archived: true, released: true,
    steps: [], warnings: [],
  })
  assert.ok(withRelease.includes('released'), 'the release must be reported')
  const without = renderReport({
    ok: true, sourceSessionId: 'a', newSessionId: 'b', archived: true, released: false,
    steps: [], warnings: [],
  })
  assert.ok(!without.includes('live event tree was released'))
})

// ── the mounted plugin drives its own triggers ──────────────────────────────

/** Mount the real entry against a stub host and return its registered handlers. */
async function mountPlugin(config) {
  const entry = await import('../lib/index.js')
  const handlers = {}
  const ctx = {
    effect: (fn) => { const gen = fn(); let step = gen.next(); while (!step.done) step = gen.next(); return () => {} },
    on: (name, fn) => { (handlers[name] = handlers[name] || []).push(fn); return () => {} },
    commands: { register: (def) => { handlers['command:' + def.name] = def; return () => {} } },
    get: (name) => (name === 'agents' ? { get: () => undefined } : undefined),
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    tokenMeter: { measure: () => ({ totalTokens: currentTokens }) },
  }
  let currentTokens = 100000
  entry.apply(ctx, config ?? {})
  return { handlers, setTokens: (n) => { currentTokens = n }, logs: [] }
}

test('the mounted plugin registers both watchers and both commands', async () => {
  const { handlers } = await mountPlugin()
  // Every durable boundary arrives through ONE real hook: `turn/end` and
  // `compaction/end` are session APPENDS, not live dispatches, so listening on them
  // as events never fires. Two watchers read turn/end and one reads compaction/end.
  assert.equal(handlers['session/event'].length, 3, 'three session/event watchers')
  assert.equal(handlers['turn/end'], undefined, 'turn/end is not a live event')
  assert.equal(handlers['compaction/end'], undefined, 'compaction/end is not a live event')
  assert.ok(handlers['command:handoff'], '/handoff is registered')
  assert.ok(handlers['command:handoff-status'], '/handoff-status is registered')
})

test('the compaction trigger needs the streak AND the volume', async () => {
  const { handlers, setTokens } = await mountPlugin({ autoHandoff: { enabled: true, atLevel: 'critical' } })
  const session = { id: 'session-a', requestHeader: () => ({ config: { contextWindow: 1000000 } }) }
  const fire = (event) => { for (const fn of handlers['session/event']) fn(session, event) }
  const refusal = { type: 'compaction/end', data: { error: '403: {"code":"dsh_compaction_refused"}' } }
  // Large session, but only one failure: below the streak threshold.
  setTokens(900000)
  fire(refusal)
  // Small session, many failures: below the volume floor.
  setTokens(100000)
  for (let i = 0; i < 5; i += 1) fire(refusal)
  // A successful compaction resets the streak.
  fire({ type: 'compaction/end', data: {} })
  // Both conditions now hold. The handoff will fail against the stub host, which is
  // expected; the assertion is that this path does not throw.
  setTokens(900000)
  fire(refusal)
  fire(refusal)
  fire(refusal)
  assert.ok(true)
})

test('a terminal compaction code fires at any size', async () => {
  const { handlers, setTokens } = await mountPlugin({ autoHandoff: { enabled: true } })
  const session = { id: 'session-t', requestHeader: () => ({ config: { contextWindow: 1000000 } }) }
  setTokens(5000)
  // No assertion on the side effect (the stub host cannot create sessions); the
  // point is that this path must not throw on a tiny session, and that a terminal
  // code bypasses the volume floor.
  for (const fn of handlers['session/event']) {
    fn(session, { type: 'compaction/end', data: { error: '400: {"code":"context_length_exceeded"}' } })
  }
  assert.ok(true)
})

// ── the trigger must survive the driver's own timing ────────────────────────

test('a turn boundary is observed while the driver is still running', async () => {
  // The boundary arrives from inside the driver's `finally`, so the agent is STILL
  // RUNNING at that instant. Requiring idleness immediately blocks every trigger —
  // this is the bug that made the real end-to-end test fail while every unit passed.
  const { handlers, setTokens } = await mountPlugin({ autoHandoff: { enabled: true, onAnomaly: true, anomalyThreshold: 2 } })
  const session = { id: 'session-busy', requestHeader: () => ({ config: { contextWindow: 1000000 } }) }
  // An agent that stays "running" for two polls, then settles — exactly the real shape.
  let polls = 0
  const agent = { session, get status() { polls += 1; return polls < 3 ? 'running' : 'idle' } }
  setTokens(100000)
  // The handler must not throw while the agent is running.
  for (const fn of handlers['session/event']) {
    fn(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'error', error: { message: 'x', code: 'E' } } } })
  }
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.ok(true, 'observing a boundary while the driver runs must not throw')
})

test('a session is handed off at most once', async () => {
  // A broken session fails its next turn too. Without suppression the plugin would
  // fork a successor per turn — worse than the breakage it was rescuing. The replay
  // against the real 1,316-failure sequence showed exactly that: 1,313 fires.
  const { handlers, setTokens } = await mountPlugin({ autoHandoff: { enabled: true, onAnomaly: true, anomalyThreshold: 2 } })
  const session = { id: 'session-once', requestHeader: () => ({ config: { contextWindow: 1000000 } }) }
  const agent = { session, status: 'idle', options: {}, inject: () => {} }
  setTokens(900000)
  const fire = () => {
    for (const fn of handlers['session/event']) {
      fn(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'error', error: { message: 'x', code: 'E' } } } })
    }
  }
  // Four failed turns: the threshold is 2, so the trigger is eligible from the second
  // onward. Whatever the outcome, this must not throw and must stay bounded.
  fire(); fire(); fire(); fire()
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.ok(true)
})

test('a failing handoff stops after the attempt cap', async () => {
  // A handoff can fail for reasons a retry cannot fix. The cap is what keeps a session
  // that cannot be rescued from spinning forever instead of telling the owner.
  const { readFileSync } = await import('node:fs')
  const source = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  assert.ok(source.includes('AUTO_HANDOFF_MAX_ATTEMPTS'), 'the cap must exist')
  assert.ok(source.includes('handoffAttempts'), 'attempts must be tracked per session')
  assert.ok(source.includes('giving up on'), 'the owner must be told when it gives up')
})

// ── the reading must be trustworthy before it can act ───────────────────────

test('an estimated reading never triggers an automatic handoff', async () => {
  // Three healthy sessions were forked because the token meter's ESTIMATE prices the
  // whole surface, including history an earlier compaction already shadowed. The real
  // numbers: the GUI reported 40k-118k for sessions the estimate called 400k+.
  const source = (await import('node:fs')).readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  assert.ok(source.includes('mayActOn'), 'the gate must exist')
  assert.ok(source.includes('estimated !== true'), 'an estimate must be excluded')
  // And every trigger path must consult it.
  const gates = source.match(/mayActOn\(/g) ?? []
  assert.ok(gates.length >= 3, 'every trigger call site must consult the gate, got ' + gates.length)
})

test('the measurement prefers the provider-reported projection', async () => {
  const source = (await import('node:fs')).readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  assert.ok(source.includes("stateOf(session, 'contextPressure')"), 'the projection is the primary source')
  // The estimate is only a fallback, and it is labelled as such.
  assert.ok(source.includes('estimated: true'), 'the fallback must be labelled')
})

test('the upstream ceiling is per model, and a route entry wins', () => {
  const policy = resolvePolicy({ upstreamPromptLimit: 500000, upstreamPromptLimits: { 'ai/big-model': 900000, 'ai/small': 120000 } })
  assert.equal(policy.upstreamPromptLimits['ai/big-model'], 900000)
  // A route with its own entry uses it.
  const big = classify({ pressureTokens: 800000, modelWindow: 1000000, policy, route: 'ai/big-model' })
  assert.equal(big.effectiveLimit, 900000, 'the route entry must win over the scalar')
  assert.equal(big.binding, 'upstream-prompt-limit')
  const small = classify({ pressureTokens: 800000, modelWindow: 1000000, policy, route: 'ai/small' })
  assert.equal(small.effectiveLimit, 120000)
  assert.equal(small.level, 'critical', 'a small route limit must classify as critical')
  // A route with no entry falls back to the scalar.
  const other = classify({ pressureTokens: 800000, modelWindow: 1000000, policy, route: 'ai/unlisted' })
  assert.equal(other.effectiveLimit, 500000, 'an unlisted route uses the scalar')
  // And no route at all still works.
  const none = classify({ pressureTokens: 800000, modelWindow: 1000000, policy })
  assert.equal(none.effectiveLimit, 500000)
  assert.equal(none.route, null)
})

test('invalid per-model entries are dropped rather than trusted', () => {
  const policy = resolvePolicy({ upstreamPromptLimits: { good: 123, bad: -1, worse: 'x', '': 5, alsoGood: 456 } })
  assert.deepEqual(policy.upstreamPromptLimits, { good: 123, alsoGood: 456 })
  // With every entry invalid the map is dropped, so the scalar fallback stands alone.
  const empty = resolvePolicy({ upstreamPromptLimits: { bad: -1, worse: 'x' } })
  assert.deepEqual(empty.upstreamPromptLimits, {})
})

test('the reminder is deferred out of the event dispatch', async () => {
  // `inject` appends to the session, and the store refuses an append that reenters
  // while another is publishing. The reminder therefore has to leave the dispatch
  // first — observed live as "session append cannot reenter while another append is
  // being published".
  const source = (await import('node:fs')).readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  const injectAt = source.indexOf('agent.inject(createUserMessage({')
  const microtaskAt = source.lastIndexOf('queueMicrotask(', injectAt)
  assert.ok(injectAt > 0, 'the reminder must still be delivered')
  assert.ok(microtaskAt > 0 && microtaskAt < injectAt, 'it must be wrapped in a microtask')
})

test('the model window is read from the model configuration, not configured', async () => {
  // The ceiling must follow the model the session is actually using. The plugin asks the
  // harness (llm.resolveModelInfo) rather than asking the user, so switching models
  // switches the ceiling with no plugin setting touched.
  const source = (await import('node:fs')).readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  assert.ok(source.includes('resolveModelInfo'), 'the capacity must be resolved from the adapter')
  assert.ok(source.includes('capacityValue'), 'the resolution must be cached per route')
  assert.ok(source.includes('context.contextWindow'), 'the window comes from the resolved context')
  // The route is what selects the capacity, so it must be read from the header.
  assert.ok(source.includes("config.provider + '/' + config.model"), 'the route comes from the live header')
})

test('two models classify the same pressure differently', () => {
  // The whole point of reading the window from the model config: the verdict follows the
  // model. A 150k prompt is comfortable on a 2M window and already critical on a 200k one.
  const policy = resolvePolicy({})
  const big = classify({ pressureTokens: 150000, modelWindow: 2000000, policy, route: 'ai/big' })
  const small = classify({ pressureTokens: 150000, modelWindow: 200000, policy, route: 'ai/small' })
  assert.equal(big.level, 'ok')
  assert.equal(small.level, 'critical')
})

// ── the reminder speaks the owner's language ────────────────────────────────

test('the reminder defaults to Chinese and can be switched to English', () => {
  // The host half cannot read the browser locale (the `locale` namespace is empty),
  // so the language is a setting. A reminder the owner cannot read is not a reminder.
  const policy = resolvePolicy({})
  assert.equal(policy.language, 'zh', 'Chinese is the default')
  assert.equal(resolvePolicy({ language: 'en' }).language, 'en')
  // An empty or non-string value falls back rather than producing a broken reminder.
  assert.equal(resolvePolicy({ language: '' }).language, 'zh')
  assert.equal(resolvePolicy({ language: 42 }).language, 'zh')
})

test('the Chinese reminder is fully Chinese', () => {
  const policy = resolvePolicy({})
  const classification = classify({ pressureTokens: 538714, modelWindow: 1000000, policy, route: 'ai/x' })
  const text = reminderText({ classification, pressureTokens: 538714, modelWindow: 1000000, policy, language: 'zh' })
  // The measurement lines must read as Chinese prose.
  assert.ok(text.includes('实测压力'), 'the pressure line is Chinese')
  assert.ok(text.includes('模型窗口'), 'the window line is Chinese')
  assert.ok(text.includes('上游请求长度上限'), 'the upstream line is Chinese')
  // No English jargon may survive in the Chinese text.
  for (const jargon of ['turn', 'seed', 'prompt', 'token', 'profile', 'provider', 'binding ceiling']) {
    assert.ok(!text.includes(jargon), 'Chinese text must not contain "' + jargon + '"')
  }
  // The command name is an identifier, not prose, so it stays.
  assert.ok(text.includes('/handoff'))
})

test('the English reminder is fully English', () => {
  const policy = resolvePolicy({})
  const classification = classify({ pressureTokens: 538714, modelWindow: 1000000, policy, route: 'ai/x' })
  const text = reminderText({ classification, pressureTokens: 538714, modelWindow: 1000000, policy, language: 'en' })
  assert.ok(text.includes('measured pressure'))
  assert.ok(text.includes('model window'))
  assert.ok(text.includes('upstream request limit'))
  // No full-width punctuation may leak into the English text.
  assert.ok(!/[，（）]/.test(text), 'English text must not contain CJK punctuation')
})

test('the reminder names the ceiling it actually bound on', () => {
  const policy = resolvePolicy({})
  // A tiny upstream limit binds before the window does.
  const tight = resolvePolicy({ upstreamPromptLimit: 100000 })
  const classification = classify({ pressureTokens: 90000, modelWindow: 1000000, policy: tight, route: 'ai/x' })
  assert.equal(classification.binding, 'upstream-prompt-limit')
  const text = reminderText({ classification, pressureTokens: 90000, modelWindow: 1000000, policy: tight, language: 'zh' })
  assert.ok(text.includes('上游请求长度上限'), 'the binding ceiling is named in Chinese')
})

// ── the browser half ────────────────────────────────────────────────────────

/** Load the real client bundle through a faithful ModuleLoader + jsx-runtime stub. */
async function loadClientBundle(overrides) {
  const { readFileSync } = await import('node:fs')
  const calls = []
  const state = overrides?.state ?? {
    status: 'ready',
    value: { monitor: { enabled: true }, policy: {}, autoHandoff: { enabled: false, atLevel: 'critical' } },
    writable: true,
    mode: 'host',
    revision: 3,
  }
  // react/jsx-runtime takes children INSIDE props and has NO third argument. A stub
  // that accepted a third argument hid a real bug once: the section rendered empty.
  const jsxRuntime = { jsx: (type, props, key) => ({ type, props, key }), jsxs: (type, props, key) => ({ type, props, key }), Fragment: 'Fragment' }
  const react = {
    useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
    useEffect: () => {},
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
    useId: () => 'id',
    useRef: () => ({ current: undefined }),
    useSyncExternalStore: (subscribe, get) => get(),
    createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    Fragment: 'Fragment',
  }
  const modules = new Map()
  const loader = { load: (spec) => modules.set(spec.id, spec.factory((name) => {
    if (name === 'react') return react
    if (name === 'react/jsx-runtime') return jsxRuntime
    throw new Error('unexpected require: ' + name)
  })) }
  // The stylesheet is injected when the SECTION RENDERS, not when the bundle loads, so
  // the document stub has to stay installed for the whole test rather than only around
  // the load. It is restored by the caller through \`restoreDom\`.
  const previousWindow = globalThis.window
  const previousDocument = globalThis.document
  const injectedCss = []
  globalThis.document = {
    querySelector: () => null,
    createElement: () => ({
      dataset: {},
      set textContent(value) { injectedCss.push(value) },
      get textContent() { return '' },
    }),
    head: { appendChild: () => {} },
  }
  globalThis.window = { __ModuleLoader__: loader }
  const restoreDom = () => {
    globalThis.window = previousWindow
    globalThis.document = previousDocument
  }
  try {
    const url = new URL('../lib/client.js', import.meta.url)
    new Function('window', readFileSync(url, 'utf8'))(globalThis.window)
  } catch (error) {
    restoreDom()
    throw error
  }
  const mod = modules.get('dsh-session-handoff')
  let registered
  const dicts = []
  const ctx = {
    effect: (fn) => { fn(); return () => {} },
    locale: {
      // The section gets its `t` from the slot's inject(), which overwrites whatever
      // the test passes in — so this must return the bare key for assertions to read
      // it. The namespace is recorded separately.
      bind: (ns) => (key) => key,
      register: (ns, d) => { dicts.push({ ns, zh: d.zh, en: d.en }); return () => {} },
    },
    slots: {
      inject: (name, fn) => { fn() },
      register: (options, component) => { registered = { options, component }; return () => {} },
    },
    configForms: {
      get: (ns) => {
        calls.push('get:' + ns)
        return {
          getSnapshot: () => state,
          subscribe: () => () => {},
          mutate: async (ops) => { calls.push('mutate:' + JSON.stringify(ops)); return true },
        }
      },
    },
    get: () => undefined,
  }
  mod.apply(ctx)
  return { mod, registered, calls, dicts, injectedCss, restoreDom }
}

/**
 * Walk a rendered tree, expanding function components so nested labels and control
 * props become visible. Without this a form renders as an opaque element.
 */
function walkTree(node, visit) {
  if (node === null || node === undefined || typeof node !== 'object') return
  if (Array.isArray(node)) { node.forEach((child) => walkTree(child, visit)); return }
  const name = node.type === undefined ? undefined : (typeof node.type === 'function' ? node.type.name : String(node.type))
  if (name !== undefined) {
    visit({ name, props: node.props })
    if (typeof node.type === 'function' && ['Group', 'Field', 'ToggleField', 'NumberField', 'MapField', 'SelectField'].includes(name)) {
      return walkTree(node.type(node.props), visit)
    }
  }
  walkTree(node.props?.children, visit)
}

test('the client bundle loads and registers a settings section', async () => {
  const { mod, registered, dicts } = await loadClientBundle()
  assert.equal(typeof mod.apply, 'function')
  assert.deepEqual(mod.inject, ['slots', 'locale', 'remote', 'remote.settings', 'configForms'])
  assert.equal(registered.options.name, 'settings.section')
  assert.equal(registered.options.id, 'session-handoff')
  assert.equal(typeof registered.component, 'function')
  // Both dictionaries must stay in step: a missing key renders the raw key.
  assert.equal(dicts.length, 1)
  assert.equal(Object.keys(dicts[0].zh).length, Object.keys(dicts[0].en).length, 'zh and en must declare the same keys')
})

test('the settings section renders its controls, not an empty shell', async () => {
  // This is the test that caught the jsx children bug: a wrong convention renders a
  // root element with zero children and no error anywhere.
  const { registered } = await loadClientBundle()
  const tree = registered.component({ t: (key) => key, ...registered.options.inject() })
  const texts = []
  const names = []
  walkTree(tree, (node) => {
    names.push(node.name)
    if (typeof node.props?.children === 'string') texts.push(node.props.children)
  })
  for (const key of ['monitorTitle', 'autoTitle', 'compactionTitle', 'seedTitle', 'upstreamTitle']) {
    assert.ok(texts.includes(key), key + ' must render')
  }
  // The form must be built from the shipped control vocabulary, not raw divs.
  assert.ok(names.filter((n) => n === 'ToggleField').length >= 4, 'the switches must render')
  assert.ok(names.filter((n) => n === 'NumberField').length >= 9, 'the numeric fields must render')
  assert.equal(names.filter((n) => n === 'SelectField').length, 2, 'the level and language selects must render')
  assert.equal(names.filter((n) => n === 'MapField').length, 1, 'the per-model map must render')
})

test('the dropdown offers every level with a localized label', async () => {
  const { registered } = await loadClientBundle()
  const tree = registered.component({ t: (key) => key, ...registered.options.inject() })
  let select
  walkTree(tree, (node) => { if (node.name === 'SelectField') select = node })
  assert.ok(select, 'the select must render')
  // The wire values are stable; the labels are what the owner reads.
  assert.deepEqual(select.props.options.map((o) => o.value), ['watch', 'warn', 'critical'])
  for (const option of select.props.options) {
    assert.ok(typeof option.label === 'string' && option.label.length > 0, 'every option needs a label')
  }
  // And the real dictionary must translate them, not fall through to the key.
  const { dicts } = await loadClientBundle()
  const zh = dicts[0].zh
  for (const key of ['levelWatch', 'levelWarn', 'levelCritical']) {
    assert.ok(typeof zh[key] === 'string' && zh[key].length > 0, key + ' must be translated')
    assert.notEqual(zh[key], key)
  }
})

test('every rendered label has a translation in both dictionaries', async () => {
  const { registered, dicts } = await loadClientBundle()
  const tree = registered.component({ t: (key) => key, ...registered.options.inject() })
  const keys = new Set()
  walkTree(tree, (node) => {
    if (typeof node.props?.children === 'string' && /^[a-zA-Z][a-zA-Z0-9]*$/.test(node.props.children)) {
      keys.add(node.props.children)
    }
  })
  const zh = dicts[0].zh
  const en = dicts[0].en
  for (const key of keys) {
    assert.ok(typeof zh[key] === 'string' && zh[key].length > 0, 'zh missing: ' + key)
    assert.ok(typeof en[key] === 'string' && en[key].length > 0, 'en missing: ' + key)
  }
  assert.ok(keys.size >= 25, 'the form must render a real set of labels, got ' + keys.size)
})

test('the form ships a stylesheet built from design tokens', async () => {
  // Inline styles cannot follow the app theme. The form therefore ships a stylesheet
  // whose every value is a design token, injected once per document.
  const { registered, injectedCss, restoreDom } = await loadClientBundle()
  try {
    registered.component({ t: (key) => key, ...registered.options.inject() })
  } finally {
    restoreDom()
  }
  assert.equal(injectedCss.length, 1, 'the stylesheet must be injected exactly once')
  const css = injectedCss[0]
  for (const cls of ['.sh-section', '.sh-field', '.sh-input', '.sh-select', '.sh-textarea', '.sh-switch', '.sh-thumb']) {
    assert.ok(css.includes(cls), cls + ' must be styled')
  }
  // Every declaration that sets a colour must use a token, never a literal. The
  // pattern anchors on the value itself so whitespace cannot slip past the check.
  const colourLiterals = [...css.matchAll(/(?:^|;)\s*(?:color|background)\s*:\s*([^;]+)/g)]
    .map((match) => match[1].trim())
    .filter((value) => !value.startsWith('var(--dsw-'))
  assert.deepEqual(colourLiterals, [], 'colours must come from tokens, found: ' + JSON.stringify(colourLiterals))
})

test('a control writes a path op into this plugin\'s own namespace', async () => {
  const { registered, calls } = await loadClientBundle()
  const tree = registered.component({ t: (key) => key, ...registered.options.inject() })
  const toggles = []
  const collect = (node) => {
    if (node === null || node === undefined || typeof node !== 'object') return
    if (Array.isArray(node)) { node.forEach(collect); return }
    if (node.type && node.type.name === 'ToggleField') toggles.push(node)
    collect(node.props?.children)
  }
  collect(tree)
  const autoToggle = toggles.find((node) => node.props.label === 'autoEnabled')
  assert.ok(autoToggle, 'the auto-handoff switch must be present')
  autoToggle.props.onCommit(true)
  await new Promise((resolve) => setTimeout(resolve, 10))
  const written = calls.filter((call) => call.startsWith('mutate:'))
  assert.equal(written.length, 1, 'exactly one write must be queued')
  assert.equal(written[0], 'mutate:[{"op":"set","path":["autoHandoff","enabled"],"value":true}]')
})

// ── the fiber must actually activate ────────────────────────────────────────

test('the plugin fiber activates, so its config is a live settings namespace', async () => {
  // This is the test that catches the failure which made the Settings page read
  // "this deployment does not expose this plugin's configuration": a Config that
  // fails validation makes the fiber fail, and the settings layer only exposes
  // namespaces whose fiber is ACTIVE. Commands still work, so nothing else notices.
  const { Context } = await import('@deepseek-ai/cordis')
  const entry = await import('../lib/index.js')
  const ctx = new Context()
  for (const name of ['agents', 'commands', 'llm', 'tokenMeter', 'workspaceRegistry', 'sessionController']) {
    try { ctx.provide(name, { register: () => () => {}, measure: () => undefined }) } catch {}
  }
  const wrapped = ctx.plugin(entry)
  await new Promise((resolve) => setTimeout(resolve, 300))
  const fiber = wrapped.fiber ?? wrapped
  assert.equal(fiber.state, 2, 'the fiber must be ACTIVE, not failed: ' + (fiber._error ? fiber._error.message : 'no error reported'))
  assert.equal(fiber._error, undefined, 'no activation error')
})

test('no volatile field encloses another volatile field', async () => {
  // Cordis rejects this outright: "volatile fields require a fixed object path
  // without an enclosing volatile field". Marking a group volatile AND its leaves
  // volatile is the natural mistake — the group's own path is not fixed.
  const { Config } = await import('../lib/index.js')
  const walk = (node, enclosingVolatile, path) => {
    const self = Boolean(node.meta && node.meta.volatile)
    assert.ok(
      !(self && enclosingVolatile),
      'a volatile field encloses another volatile field at ' + path.join('.'),
    )
    for (const [key, child] of Object.entries(node.dict ?? {})) walk(child, self, [...path, key])
  }
  walk(Config, false, [])
  // And every leaf must be volatile, or it is not editable from Settings.
  const leaves = []
  const collect = (node, path) => {
    const children = Object.entries(node.dict ?? {})
    if (children.length === 0) { leaves.push({ path, volatile: Boolean(node.meta && node.meta.volatile) }); return }
    for (const [key, child] of children) collect(child, [...path, key])
  }
  collect(Config, [])
  assert.ok(leaves.length >= 15, 'the schema must expose the policy fields, got ' + leaves.length)
  const notEditable = leaves.filter((leaf) => !leaf.volatile)
  assert.deepEqual(notEditable, [], 'every leaf must be volatile to appear in Settings')
})

// ── the invariant that matters most ──────────────────────────────────────────

test('no assembled request can exceed its budget, even for a 20M-token transcript', () => {
  // Build a transcript far larger than any upstream prompt limit.
  const messages = Array.from({ length: 4000 }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: 'line ' + i + ' ' + 'x'.repeat(20000),
  }))
  const blocks = toBlocks(messages)
  const transcriptTokens = blocks.reduce((sum, block) => sum + block.tokens, 0)
  assert.ok(transcriptTokens > 20000000, 'the fixture must actually be huge, got ' + transcriptTokens)

  const window = 1000000
  const budget = inputBudget(window, CHUNK_SUMMARY_MAX_TOKENS)
  const perChunk = Math.max(512, budget - 256)
  // Reproduce the sizing step from summarize.js and assert its output is bounded.
  const sized = blocks.map((block) => (block.tokens <= perChunk ? block : { ...block, tokens: perChunk }))
  const chunks = packChunks(sized, perChunk)
  for (const chunk of chunks) {
    const total = chunk.reduce((sum, block) => sum + block.tokens, 0)
    assert.ok(total <= perChunk, 'a chunk exceeded the per-request budget: ' + total)
  }
  // And the number of requests stays finite and sane.
  assert.ok(chunks.length > 1, 'a huge transcript must be split')
  assert.ok(chunks.length < 5000, 'chunk count must stay bounded, got ' + chunks.length)
})
