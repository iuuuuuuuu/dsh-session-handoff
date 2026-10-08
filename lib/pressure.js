/**
 * Context-pressure monitoring and the advice it produces.
 *
 * The plugin must answer one question continuously: *is this session about to
 * become unmaintainable?* "Unmaintainable" has a precise meaning here — the
 * session's own compaction request would exceed the upstream prompt limit, so
 * the only automatic recovery path stops working and every later turn fails.
 *
 * That threshold is not the model window. Compaction replays the whole shadowed
 * region, so the danger point arrives well before the window fills. The monitor
 * therefore tracks two independent ceilings and advises on whichever binds
 * first.
 *
 * @module dsh-session-handoff/pressure
 */

/**
 * Compaction failure codes that mean the session itself is now unserviceable.
 *
 * These mean the request no longer fits at all, so they are terminal at ANY size —
 * the volume floor cannot apply, because there is no size at which the request
 * would be accepted again.
 *
 * `no_healthy_account` is deliberately NOT here. It is a platform-level pool
 * exhaustion: every session on that route fails identically, so handing off would
 * archive a working session to fix a fault the successor inherits. It is reported
 * but never triggers.
 */
export const TERMINAL_COMPACTION_CODES = [
  'context_length_exceeded',
  'model_param_invalid',
]

/** Compaction failure codes that are a policy refusal and may still recover. */
export const RECOVERABLE_COMPACTION_CODES = [
  'dsh_compaction_refused',
]

/**
 * Default policy. Every field is overridable through plugin config.
 *
 * `upstreamPromptLimit` is the hard ceiling the provider enforces on one
 * request. It cannot be derived from the model window: a routed model may
 * advertise a large window while the upstream account enforces a smaller one.
 * Measured behaviour is the authority, so this is configuration rather than a
 * guess baked into code.
 */
export const DEFAULT_POLICY = {
  upstreamPromptLimit: 1048576,
  /** Per-route measured ceilings, keyed \`provider/model\`. Overrides the scalar. */
  upstreamPromptLimits: {},
  watchRatio: 0.45,
  warnRatio: 0.6,
  criticalRatio: 0.75,
  remindEveryTokens: 50000,
  remindCooldownMs: 10 * 60 * 1000,
  seedBudgetTokens: 24000,
  /**
   * Share of the seed budget reserved for the verbatim recent-turns layer.
   *
   * The tail is exact while the narrative layer is a paraphrase, so the tail gets
   * a guaranteed share instead of competing with prose for what is left over.
   */
  recentShareRatio: 0.5,
  /**
   * Consecutive compaction failures required before the compaction trigger fires.
   *
   * Measured on real sessions: a policy refusal fired 1062 times across one session
   * while the session kept working, so the count alone is not a death signal.
   */
  compactionFailureThreshold: 3,
  /**
   * Volume floor, as a fraction of the model window, below which compaction
   * failures are NOT treated as an anomaly.
   *
   * This is the joint condition. Below this size compaction is not what stands
   * between the session and progress, so a failure is noise rather than a crisis —
   * which is why the trigger requires BOTH a failure streak AND this volume.
   */
  compactionAnomalyVolumeRatio: 0.35,
}

/**
 * Resolve user policy over the defaults, ignoring unusable values.
 *
 * @param {object} config - raw plugin configuration.
 * @returns {object} a complete policy.
 */
export function resolvePolicy(config) {
  const out = { ...DEFAULT_POLICY }
  if (config === undefined || config === null || typeof config !== 'object') return out
  for (const key of Object.keys(DEFAULT_POLICY)) {
    if (key === 'upstreamPromptLimits') continue
    const value = config[key]
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) continue
    out[key] = value
  }
  // Per-route ceilings: keep only finite positive numbers under a non-empty key, so a
  // malformed entry cannot silently become the ceiling for a model.
  const limits = config.upstreamPromptLimits
  if (limits !== null && typeof limits === 'object' && !Array.isArray(limits)) {
    const kept = {}
    for (const [route, value] of Object.entries(limits)) {
      if (typeof route !== 'string' || route.length === 0) continue
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) continue
      kept[route] = value
    }
    if (Object.keys(kept).length > 0) out.upstreamPromptLimits = kept
  }
  // A ratio ladder that is not strictly increasing cannot classify anything.
  if (!(out.watchRatio < out.warnRatio && out.warnRatio < out.criticalRatio)) {
    out.watchRatio = DEFAULT_POLICY.watchRatio
    out.warnRatio = DEFAULT_POLICY.warnRatio
    out.criticalRatio = DEFAULT_POLICY.criticalRatio
  }
  return out
}

/**
 * Classify current pressure against the policy.
 *
 * @param {{pressureTokens: number, modelWindow: number, policy: object}} input - measurement and policy.
 * @returns {{level: string, ratio: number, windowRatio: number, promptRatio: number, binding: string}} classification.
 */
export function classify(input) {
  const policy = input.policy
  // A route-specific measured ceiling wins over the scalar fallback: the upstream
  // prompt limit differs per model, and only a measurement knows the real number.
  const route = typeof input.route === 'string' ? input.route : undefined
  const routeLimit = route === undefined ? undefined : policy.upstreamPromptLimits?.[route]
  const effectiveLimit = Number.isFinite(routeLimit) ? routeLimit : policy.upstreamPromptLimit
  const pressure = Number.isFinite(input.pressureTokens) && input.pressureTokens > 0 ? input.pressureTokens : 0
  const window = Number.isFinite(input.modelWindow) && input.modelWindow > 0 ? input.modelWindow : 128000
  const windowRatio = pressure / window
  const promptRatio = pressure / effectiveLimit
  const binding = promptRatio >= windowRatio ? 'upstream-prompt-limit' : 'model-window'
  const ratio = Math.max(windowRatio, promptRatio)
  let level = 'ok'
  if (ratio >= policy.criticalRatio) level = 'critical'
  else if (ratio >= policy.warnRatio) level = 'warn'
  else if (ratio >= policy.watchRatio) level = 'watch'
  return { level, ratio, windowRatio, promptRatio, binding, effectiveLimit, route: route ?? null }
}

/**
 * Decide whether this observation should produce a user-visible reminder.
 *
 * Reminders are rate-limited on both growth and time, because a session parked
 * at `critical` would otherwise remind on every step. A *level change* always
 * speaks once; repeating the same level requires both a cooldown and real growth.
 *
 * @param {{classification: object, previous?: object, policy: object, now: number, pressureTokens: number}} input - classification, prior state, clock.
 * @returns {{remind: boolean, state: object}} the decision and the state to persist.
 */
export function shouldRemind(input) {
  const classification = input.classification
  const policy = input.policy
  const now = input.now
  const pressure = Number.isFinite(input.pressureTokens) && input.pressureTokens > 0 ? input.pressureTokens : 0
  const state = input.previous || { level: 'ok', tokens: 0, at: 0 }
  if (classification.level === 'ok') return { remind: false, state: { level: 'ok', tokens: pressure, at: now } }
  if (state.level !== classification.level) {
    return { remind: true, state: { level: classification.level, tokens: pressure, at: now } }
  }
  const cooled = now - (state.at || 0) >= policy.remindCooldownMs
  const grown = pressure - (state.tokens || 0) >= policy.remindEveryTokens
  if (!cooled || !grown) return { remind: false, state }
  return { remind: true, state: { level: classification.level, tokens: pressure, at: now } }
}

/**
 * Decide whether a compaction failure is an anomaly worth acting on.
 *
 * This is deliberately a JOINT condition, because neither signal alone is sound:
 *
 *   - **Failure count alone is wrong.** Measured on a real 185MB session, a policy
 *     refusal (`dsh_compaction_refused`) fired 1062 times across the whole log while
 *     the session kept doing useful work. Acting on the count alone would have torn
 *     down a working session.
 *   - **Volume alone is wrong.** A large session compacts fine; size by itself is
 *     what the pressure trigger already handles, with its own ladder.
 *
 * The condition that actually means "this session is stuck" is both: compaction is
 * failing AND the session is large enough that compaction is what stands between it
 * and progress. A *terminal* code (the request no longer fits at all) short-circuits
 * the volume test, because it is unrecoverable at any size.
 *
 * @param {{code?: string, streak: number, policy: object, pressureTokens: number, modelWindow: number}} input - the failure and the current measurement.
 * @returns {{anomaly: boolean, reason: string}} the verdict and why.
 */
export function classifyCompactionFailure(input) {
  const policy = input.policy
  const code = typeof input.code === 'string' ? input.code : 'unknown'
  const streak = Number.isFinite(input.streak) && input.streak > 0 ? input.streak : 0
  const pressure = Number.isFinite(input.pressureTokens) && input.pressureTokens > 0 ? input.pressureTokens : 0
  const window = Number.isFinite(input.modelWindow) && input.modelWindow > 0 ? input.modelWindow : 128000
  const volumeRatio = pressure / window

  if (TERMINAL_COMPACTION_CODES.includes(code)) {
    return { anomaly: true, reason: 'terminal compaction failure (' + code + ')' }
  }
  if (code === 'no_healthy_account') {
    return {
      anomaly: false,
      reason: 'no healthy account: a platform-level pool failure that a new session would inherit, so a handoff cannot fix it',
    }
  }
  if (!RECOVERABLE_COMPACTION_CODES.includes(code)) {
    // An unknown code is not trusted as a trigger: the plugin should not guess.
    return { anomaly: false, reason: 'unrecognized compaction failure code (' + code + ')' }
  }
  if (streak < policy.compactionFailureThreshold) {
    return {
      anomaly: false,
      reason: 'compaction failed ' + streak + 'x, below the threshold of ' + policy.compactionFailureThreshold,
    }
  }
  if (volumeRatio < policy.compactionAnomalyVolumeRatio) {
    return {
      anomaly: false,
      reason: 'compaction failed ' + streak + 'x but the session is only '
        + (volumeRatio * 100).toFixed(1) + '% of the window (floor '
        + (policy.compactionAnomalyVolumeRatio * 100).toFixed(0) + '%), so compaction is not what is blocking it',
    }
  }
  return {
    anomaly: true,
    reason: 'compaction failed ' + streak + 'x with the session at '
      + (volumeRatio * 100).toFixed(1) + '% of the window — compaction is what is blocking it',
  }
}

/**
 * Compose the reminder text shown to the user.
 *
 * @param {{classification: object, pressureTokens: number, modelWindow: number, policy: object}} input - classification, measurements and policy.
 * @returns {string} a short, actionable message.
 */
export function reminderText(input) {
  const classification = input.classification
  const policy = input.policy
  const pct = (value) => (value * 100).toFixed(1) + '%'
  const heads = {
    watch: 'This conversation is growing large.',
    warn: 'This conversation is approaching the point where automatic compaction stops working.',
    critical: 'This conversation has reached the point where automatic compaction can no longer run.',
  }
  const lines = [
    heads[classification.level] || 'This conversation is large.',
    '',
    '- measured pressure: ' + input.pressureTokens.toLocaleString('en-US') + ' tokens (' + pct(classification.ratio) + ' of the binding ceiling: ' + classification.binding + ')',
    '- model window: ' + input.modelWindow.toLocaleString('en-US') + ' tokens',
    '- upstream prompt limit: ' + classification.effectiveLimit.toLocaleString('en-US') + ' tokens'
      + (classification.route === null ? '' : ' (route ' + classification.route + ')'),
    '',
  ]
  if (classification.level === 'critical') {
    lines.push('Run `/handoff` to start a successor session that inherits this one\'s memory and archives this one. A handoff still works here, because it never sends the whole transcript in a single request.')
  } else {
    lines.push('You can run `/handoff` at any time to hand this work to a fresh session; it costs one summarization pass.')
  }
  return lines.join('\n')
}
