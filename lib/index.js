/**
 * dsh-session-handoff — carry a conversation's memory into a new session before
 * the old one becomes unusable.
 *
 * Two responsibilities:
 *
 *   - **Watch.** Measure each live session's context pressure and tell the user
 *     before the session reaches the point where its own compaction stops
 *     working. The binding ceiling is the upstream prompt limit, not the model
 *     window, because compaction replays the whole shadowed region.
 *   - **Hand off.** `/handoff` builds a layered memory seed (verbatim facts +
 *     earlier checkpoints + a map-reduce narrative summary), starts a successor
 *     session with that seed as its opening turn, and archives the source. Every
 *     summarization request is individually bounded, so a handoff works even when
 *     the source is already past the limit that broke compaction.
 *
 * @module dsh-session-handoff
 */
import z from '@deepseek-ai/schemastery'
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import { classify, classifyCompactionFailure, reminderText, resolvePolicy, shouldRemind } from './pressure.js'
import { renderReport, runHandoff } from './handoff.js'

/**
 * Configuration schema.
 *
 * Fields are marked `.volatile()` because that is what makes them editable from the
 * Settings UI without remounting the plugin: the harness projects only volatile
 * fields into the settings document, and the browser form writes them back through
 * the profile patch. Every field here is live — the plugin re-reads its resolved
 * policy on each observation, so a change takes effect without a restart.
 */
export const Config = z.object({
  monitor: z.object({
    enabled: z.boolean().default(true).volatile(),
  }).default({ enabled: true }),
  policy: z.object({
    upstreamPromptLimit: z.number().default(1048576).volatile(),
    // Per-route measured ceilings. A map (not a list) so the settings path op writes
    // exactly the key the user edited.
    upstreamPromptLimits: z.dict(z.number()).default({}).volatile(),
    watchRatio: z.number().default(0.45).volatile(),
    warnRatio: z.number().default(0.6).volatile(),
    criticalRatio: z.number().default(0.75).volatile(),
    remindEveryTokens: z.number().default(50000).volatile(),
    remindCooldownMs: z.number().default(600000).volatile(),
    seedBudgetTokens: z.number().default(24000).volatile(),
    recentShareRatio: z.number().default(0.5).volatile(),
    compactionFailureThreshold: z.number().default(3).volatile(),
    compactionAnomalyVolumeRatio: z.number().default(0.35).volatile(),
  }).default({}),
  autoHandoff: z.object({
    enabled: z.boolean().default(true).volatile(),
    atLevel: z.string().default('critical').volatile(),
    onAnomaly: z.boolean().default(true).volatile(),
    anomalyThreshold: z.number().default(2).volatile(),
    archive: z.boolean().default(false).volatile(),
  }).default({}),
})

export const name = 'dsh-session-handoff'
export const inject = ['agents', 'commands', 'llm', 'tokenMeter', 'workspaceRegistry', 'sessionController']

const TAG = '[session-handoff]'

/**
 * How long to wait for a session's driver to settle after a turn boundary.
 *
 * The boundary is observed from inside the driver's own `finally`, so the agent is
 * still running at that instant. A turn that just ended settles in milliseconds; the
 * bound exists so a genuinely busy session defers rather than blocks forever.
 */
const IDLE_WAIT_MS = 10000

/**
 * How many times an automatic handoff may fail for one session before it stops trying.
 *
 * A handoff can fail for reasons a retry cannot fix (an unreadable session log, a
 * missing service). Without a cap the next failed turn fires again, so a session that
 * cannot be rescued would spin forever instead of telling the owner.
 */
const AUTO_HANDOFF_MAX_ATTEMPTS = 3

/**
 * Wait until one agent is no longer running its turn.
 *
 * @param {object} agent - the agent to wait for.
 * @param {number} timeoutMs - how long to wait before giving up.
 * @returns {Promise<boolean>} true when it settled, false on timeout.
 */
function waitForIdle(agent, timeoutMs) {
  if (agent.status !== 'running') return Promise.resolve(true)
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs
    const poll = () => {
      if (agent.status !== 'running') { resolve(true); return }
      if (Date.now() >= deadline) { resolve(false); return }
      setTimeout(poll, 50)
    }
    setTimeout(poll, 50)
  })
}

/**
 * @param {...unknown} args - log arguments.
 */
function log(...args) { console.log(TAG, ...args) }

/**
 * @param {...unknown} args - log arguments.
 */
function logError(...args) { console.error(TAG, ...args) }

/**
 * Plugin entry.
 *
 * @param {object} ctx - the plugin context.
 * @param {object} config - plugin configuration.
 * @returns {Function} disposer.
 */
export function apply(ctx, config) {
  // Re-resolved on every use so a Settings-UI change takes effect immediately.
  // The form writes the profile patch, the harness reconciles the plugin's config,
  // and this reads the latest — no restart, which is what the UI promises.
  const policyNow = () => resolvePolicy(config && config.policy ? config.policy : config)

  /**
   * Whether an automatic handoff may act on this measurement.
   *
   * An estimate can over-count — it prices the whole surface, including history an
   * earlier compaction already shadowed — so acting on it forks healthy sessions. A
   * measured (provider-reported) reading is the only sound basis for taking a session
   * away from its owner.
   */
  const mayActOn = (measured) => measured !== undefined && measured.estimated !== true
  const monitorEnabled = !(config && config.monitor && config.monitor.enabled === false)
  const reminderState = new Map()
  const inflight = new Set()
  // Read live from config on every use, so toggling the switch in Settings takes
  // effect on the next turn instead of requiring a restart.
  const autoNow = () => {
    const auto = (config && config.autoHandoff) || {}
    return {
      enabled: auto.enabled !== false,
      atLevel: typeof auto.atLevel === 'string' ? auto.atLevel : 'critical',
      onAnomaly: auto.onAnomaly !== false,
      anomalyThreshold: Number.isSafeInteger(auto.anomalyThreshold) && auto.anomalyThreshold > 0
        ? auto.anomalyThreshold
        : 2,
      archive: auto.archive === true,
    }
  }
  const autoHandoff = { suppressed: new Set() }
  /** Consecutive failed turns per session, for the anomaly trigger. */
  const failureStreak = new Map()
  /** Consecutive compaction failures per session, for the compaction trigger. */
  const compactionStreak = new Map()
  /** Automatic handoff attempts per session, so a failing handoff backs off. */
  const handoffAttempts = new Map()

  /**
   * Measure one session's current pressure.
   *
   * The token meter is the authority because it prices the real surface. When it
   * fails, no estimate is fabricated — the observation is skipped instead, so a
   * reminder never rests on a guess.
   *
   * @param {object} agent - the agent whose session to measure.
   * @returns {{pressureTokens: number, modelWindow: number}|undefined} the measurement.
   */
  /**
   * Per-route model capacity, resolved once from the adapter that serves the route.
   *
   * The plugin asks the harness rather than asking the user: an adapter declares its
   * models' `contextWindow` in the model profile, and `llm.resolveModelInfo` returns
   * it. That is the model configuration the session is actually using, so the ceiling
   * follows the session instead of being typed in by hand.
   */
  const capacityPending = new Map()
  const capacityValue = new Map()

  /**
   * Resolve one route's declared capacity, caching the promise per route.
   *
   * @param {string} route - `provider/model`.
   * @returns {Promise<{contextWindow?: number, defaultMaxTokens?: number}|undefined>} the declared capacity.
   */
  function resolveCapacity(route) {
    if (capacityPending.has(route)) return
    capacityPending.set(route, true)
    const at = route.indexOf('/')
    const provider = at < 0 ? undefined : route.slice(0, at)
    const model = at < 0 ? undefined : route.slice(at + 1)
    void (async () => {
      if (provider === undefined || model === undefined) return
      try {
        const llm = ctx.get('llm')
        if (llm === undefined || typeof llm.resolveModelInfo !== 'function') return
        const info = await llm.resolveModelInfo(provider, model)
        const contextWindow = info && info.context ? info.context.contextWindow : undefined
        const defaultMaxTokens = info ? info.defaultMaxTokens : undefined
        if (!Number.isFinite(contextWindow) && !Number.isFinite(defaultMaxTokens)) return
        capacityValue.set(route, { contextWindow, defaultMaxTokens })
      } catch (error) {
        logError('could not resolve model capacity for ' + route + ':', (error && error.message) || error)
      }
    })()
  }

  /**
   * Read the session's current route, capacity, and pressure.
   *
   * Synchronous by design: it is called from event observers. The capacity comes from a
   * cache primed by a background resolve, so a route's ceiling is known from the second
   * observation onward; until then the header's own value (or the configured fallback)
   * is used, and the reading is marked so an automatic trigger will not act on it.
   *
   * @param {object} agent - the agent to measure.
   * @returns {object|undefined} the measurement.
   */
  function measure(agent) {
    const session = agent && agent.session
    if (session === undefined) return undefined
    let headerWindow
    let route
    let headerMaxTokens
    try {
      const header = session.requestHeader()
      const config = header && header.config
      headerWindow = config ? config.contextWindow : undefined
      headerMaxTokens = config ? config.maxTokens : undefined
      if (config && typeof config.provider === 'string' && typeof config.model === 'string') {
        route = config.provider + '/' + config.model
      }
    } catch { headerWindow = undefined }

    // Prime the cache; the resolved value is used from the next observation onward.
    if (route !== undefined) resolveCapacity(route)
    const declared = route === undefined ? undefined : capacityValue.get(route)

    const modelWindow = Number.isFinite(headerWindow) && headerWindow > 0
      ? headerWindow
      : (declared !== undefined && Number.isFinite(declared.contextWindow) ? declared.contextWindow : undefined)

    // Prefer the harness's own `contextPressure` projection: it publishes the
    // PROVIDER-REPORTED prompt occupancy, which is the number that actually decides
    // whether the next request fits. The token meter's `totalTokens` is an estimate of
    // the whole surface — including history an earlier compaction already shadowed —
    // and it read 400k+ on a healthy session that was really at 40k.
    try {
      const projections = ctx.get('sessionProjections')
      const pressure = projections === undefined ? undefined : projections.stateOf(session, 'contextPressure')
      if (pressure !== undefined) {
        const window = Number.isFinite(modelWindow) && modelWindow > 0
          ? modelWindow
          : (Number.isFinite(pressure.contextWindow) && pressure.contextWindow > 0 ? pressure.contextWindow : undefined)
        const tokens = Number.isFinite(pressure.projectedTokens) && pressure.projectedTokens > 0
          ? pressure.projectedTokens
          : pressure.pressureTokens
        if (Number.isFinite(tokens) && tokens > 0 && window !== undefined) {
          return { pressureTokens: tokens, modelWindow: window, route, measured: true }
        }
      }
    } catch (error) {
      logError('context pressure read failed:', (error && error.message) || error)
    }

    // The meter is a fallback only, and it is labelled so no automatic trigger acts on it.
    if (!Number.isFinite(modelWindow) || modelWindow <= 0) {
      if (declared !== undefined && Number.isFinite(declared.contextWindow)) modelWindow = declared.contextWindow
      else modelWindow = undefined
    }
    try {
      const meter = ctx.tokenMeter.measure(session)
      const tokens = meter && meter.totalTokens
      if (Number.isFinite(tokens) && tokens > 0) {
        return {
          pressureTokens: tokens,
          modelWindow: Number.isFinite(modelWindow) && modelWindow > 0 ? modelWindow : 128000,
          route,
          estimated: true,
        }
      }
    } catch (error) {
      logError('token measurement failed:', (error && error.message) || error)
    }
    return undefined
  }

  /**
   * Decide whether this session may be handed off automatically, and do it.
   *
   * Automatic handoff is OFF unless the config turns it on. That default is a
   * deliberate trade-off: handing off is cheap to do and awkward to undo, the new
   * session is a successor rather than the same session, and the owner may be
   * mid-thought even at a turn boundary. So the plugin never archives a session the
   * owner did not agree to lose without an explicit opt-in.
   *
   * When enabled it is gated three ways, all of which must hold:
   *   1. pressure is at the configured level (default: critical);
   *   2. the session is idle — the hook runs at a turn boundary, so no turn is open;
   *   3. the owner has not disabled it for this session at runtime.
   *
   * @param {object} agent - the agent whose session is being evaluated.
   * @param {object} classification - the pressure classification.
   */
  function maybeAutoHandoff(agent, classification, anomaly) {
    if (!autoNow().enabled) return
    const session = agent && agent.session
    if (session === undefined) return
    if (autoHandoff.suppressed.has(session.id)) return
    if (inflight.has(session.id)) return

    // Two independent triggers. Pressure is the slow one; a failure streak is the
    // fast one and catches a session that is broken well below the pressure line.
    let trigger
    if (anomaly !== undefined) {
      if (autoNow().onAnomaly !== true) return
      if (anomaly.streak < autoNow().anomalyThreshold) return
      trigger = 'anomaly:' + anomaly.anomaly + ' x' + anomaly.streak
    } else {
      if (classification === undefined || classification.level !== autoNow().atLevel) return
      trigger = 'pressure:' + classification.level
    }

    inflight.add(session.id)
    void (async () => {
      try {
        // A turn boundary is observed from inside the driver's own `finally`, so the
        // agent is STILL RUNNING at this instant. Waiting for it to settle is the
        // difference between a trigger that works and one that never fires; the turn
        // is over, so this takes milliseconds.
        const idle = await waitForIdle(agent, IDLE_WAIT_MS)
        if (!idle) {
          log('auto-handoff abandoned for ' + session.id + ': the agent stayed busy for ' + IDLE_WAIT_MS + 'ms')
          return
        }
        log('auto-handoff firing for ' + session.id + ' (' + trigger + ')')
        const report = await runHandoff({
          ctx,
          agent,
          config,
          // The owner said automatic handoff is required but automatic archiving is
          // not, so the source stays visible unless the config says otherwise.
          archive: autoNow().archive === true,
          onProgress: (p) => log('auto progress: ' + JSON.stringify(p)),
        })
        log('auto-handoff ' + (report.ok ? 'succeeded' : 'did not complete') + ': ' + JSON.stringify(report.warnings))
        // A session that has been handed off must not be handed off again. Without
        // this the next failed turn fires another successor, and a broken session
        // forks once per turn — which is worse than the breakage it was rescuing.
        if (report.ok) {
          autoHandoff.suppressed.add(session.id)
          handoffAttempts.delete(session.id)
        } else {
          // A handoff that fails must not retry forever: the next failed turn would
          // fire again, and a session that cannot be read would spin. After the cap
          // the session is left alone and the owner is told to run /handoff by hand.
          const attempts = (handoffAttempts.get(session.id) || 0) + 1
          handoffAttempts.set(session.id, attempts)
          if (attempts >= AUTO_HANDOFF_MAX_ATTEMPTS) {
            autoHandoff.suppressed.add(session.id)
            log('auto-handoff giving up on ' + session.id + ' after ' + attempts + ' attempts; run /handoff manually to see why')
          }
        }
      } catch (error) {
        logError('auto-handoff failed:', (error && error.stack) || error)
      } finally {
        inflight.delete(session.id)
      }
    })()
  }

  /**
   * Evaluate one session, remind the user, and optionally hand it off.
   *
   * Runs at a turn boundary, which is the only moment the session is guaranteed
   * idle — an automatic handoff must never fire mid-turn, because archiving the
   * session the user is working in would take the work away from them.
   *
   * @param {object} agent - the agent to evaluate.
   */
  function observe(agent) {
    if (!monitorEnabled) return
    const session = agent && agent.session
    if (session === undefined) return
    const measured = measure(agent)
    if (measured === undefined) return
    const policy = policyNow()
    const classification = classify({ ...measured, policy, route: measured.route })
    const decision = shouldRemind({
      classification,
      previous: reminderState.get(session.id),
      policy,
      now: Date.now(),
      pressureTokens: measured.pressureTokens,
    })
    reminderState.set(session.id, decision.state)
    // An ESTIMATED reading must never take a session away from its owner: the estimate
    // prices the whole surface, including history an earlier compaction already
    // shadowed, and it is how three healthy sessions were forked.
    if (mayActOn(measured)) maybeAutoHandoff(agent, classification)
    if (!decision.remind) return
    const text = reminderText({ classification, ...measured, policy })
    // The reminder is delivered from inside a `session/event` dispatch, and `inject`
    // appends to the session — which the store refuses while another append is still
    // publishing ("session append cannot reenter"). Deferring to a microtask lets the
    // dispatch unwind first; the reminder is context for the NEXT pre-step either way.
    queueMicrotask(() => {
      try {
        // A reminder the owner never sees is not a reminder. The transcript renders a
        // user message whose source declares the `notice` form, and the form requires a
        // one-line summary — so both are supplied. `inject` keeps it model-facing
        // context for the next pre-step, which does NOT wake the driver and therefore
        // does not start a turn on its own.
        agent.inject(createUserMessage({
          content: [{ type: 'text', text }],
          source: {
            kind: 'session-handoff',
            form: 'notice',
            summary: boundContextSummary(
              'context ' + (classification.ratio * 100).toFixed(0) + '% of the ' + classification.binding
                + ' — run /handoff',
            ),
          },
        }))
        log('reminded session ' + session.id + ' at ' + classification.level + ' (' + measured.pressureTokens + ' tokens)')
      } catch (error) {
        logError('could not deliver the reminder:', (error && error.message) || error)
      }
    })
  }

  /**
   * The `/handoff` command.
   *
   * @param {object} invocation - the command invocation supplied by the host.
   * @returns {Promise<{kind: string, text: string}>} the command outcome.
   */
  async function handoffCommand(invocation) {
    const agent = invocation && invocation.agent
    if (agent === undefined || agent.session === undefined) {
      return { kind: 'error', text: 'handoff needs a live session.' }
    }
    if (inflight.has(agent.session.id)) {
      return { kind: 'error', text: 'a handoff is already running for this session.' }
    }
    inflight.add(agent.session.id)
    try {
      const measured = measure(agent)
      if (measured !== undefined) {
        const policy = policyNow()
        const classification = classify({ ...measured, policy, route: measured.route })
        log('handoff ' + agent.session.id + ': ' + classification.level + ' at ' + measured.pressureTokens + ' tokens (' + classification.binding + ')')
      }
      const report = await runHandoff({
        ctx,
        agent,
        config,
        signal: invocation.signal,
        request: invocation,
        onProgress: (progress) => log('progress: ' + JSON.stringify(progress)),
      })
      return { kind: report.ok ? 'success' : 'error', text: renderReport(report) }
    } catch (error) {
      logError('handoff failed:', (error && error.stack) || error)
      return { kind: 'error', text: 'handoff failed: ' + String((error && error.message) || error) }
    } finally {
      inflight.delete(agent.session.id)
    }
  }

  ctx.effect(function* () {
    yield async () => { await Promise.allSettled([...inflight]) }
    yield ctx.commands.register({
      name: 'handoff-status',
      description: 'Show what the session-handoff monitor measures for this session, whether a reminder is due, and whether automatic handoff is armed.',
      handler: (invocation) => {
        const agent = invocation && invocation.agent
        const measured = agent === undefined ? undefined : measure(agent)
        const lines = []
        if (measured === undefined) {
          lines.push('No measurement available for this session yet (it needs one completed turn).')
        } else {
          const policy = policyNow()
          const classification = classify({ ...measured, policy, route: measured.route })
          lines.push('Context pressure: ' + measured.pressureTokens.toLocaleString('en-US') + ' tokens')
          lines.push('Level: ' + classification.level + ' (' + (classification.ratio * 100).toFixed(1) + '% of the binding ceiling: ' + classification.binding + ')')
          lines.push('Model window: ' + measured.modelWindow.toLocaleString('en-US') + ' tokens')
          lines.push('Upstream prompt limit: ' + policy.upstreamPromptLimit.toLocaleString('en-US') + ' tokens')
          lines.push('')
          lines.push(classification.level === 'ok'
            ? 'Nothing to do yet.'
            : 'Run /handoff to move this work to a fresh session.')
        }
        lines.push('')
        lines.push('Monitor: ' + (monitorEnabled ? 'on' : 'off'))
        lines.push('Automatic handoff: ' + (autoNow().enabled
          ? 'ARMED — triggers: pressure at "' + autoNow().atLevel + '"'
            + (autoNow().onAnomaly ? ', or ' + autoNow().anomalyThreshold + ' consecutive failed turns' : ' (anomaly trigger off)')
            + '. The session is handed off, its work stopped, its memory released, and it is archived.'
          : 'off (default). Enable it with config.autoNow().enabled: true if you want the plugin to hand off and archive without asking.'))
        lines.push('Archiving frees memory: yes — the handoff releases the live event tree after archiving, and the session stays readable on disk.')
        return { kind: 'success', text: lines.join('\n') }
      },
    })
    yield ctx.commands.register({
      name: 'handoff',
      description: 'Carry this conversation into a fresh session: build a layered memory seed, start a successor with it, then archive this one. Works even when the session is too large to compact.',
      handler: handoffCommand,
    })
    // Observe at turn boundaries rather than on a timer: the meter is O(surface),
    // so it must run at a deliberate cadence.
    // `turn/end` is a DURABLE session append, not a live dispatch — listening on it
    // as an event never fires. `session/event` is the real hook: it carries every
    // append with (session, event), and it is dispatched through the session's own
    // carrier so a listener sees exactly the sessions in its scope.
    yield ctx.on('session/event', (session, event) => {
      try {
        if (event === undefined || event.type !== 'turn/end') return
        const agents = ctx.get('agents')
        const agent = agents === undefined ? undefined : agents.get(session.id)
        if (agent === undefined) return
        observe(agent)
      } catch (error) {
        logError('observation failed:', (error && error.message) || error)
      }
    })
    // Compaction watching. A compaction failure is an anomaly, but only when the
    // session is also large enough that compaction is what is blocking progress:
    // measured on a real 185MB session, a policy refusal fired 1062 times while the
    // session kept working, so the count alone must never trigger a handoff.
    yield ctx.on('session/event', (session, event) => {
      try {
        if (event === undefined || event.type !== 'compaction/end') return
        const agents = ctx.get('agents')
        const agent = agents === undefined ? undefined : agents.get(session.id)
        if (agent === undefined) return
        const error = event.data && event.data.error
        if (error === undefined) {
          compactionStreak.delete(session.id)
          return
        }
        const streak = (compactionStreak.get(session.id) || 0) + 1
        compactionStreak.set(session.id, streak)
        const code = String(error).match(/"code":"([^"]+)"/)?.[1]
          ?? (String(error).match(/^\d{3}:\s*\{/) ? 'unknown' : 'unknown')
        const measured = measure(agent)
        if (measured === undefined) return
        const verdict = classifyCompactionFailure({ code, streak, policy: policyNow(), ...measured })
        log('compaction failed for ' + session.id + ' (' + code + ' x' + streak + '): ' + verdict.reason)
        if (verdict.anomaly && mayActOn(measured)) maybeAutoHandoff(agent, undefined, { anomaly: 'compaction:' + code, streak })
      } catch (error) {
        logError('compaction observation failed:', (error && error.message) || error)
      }
    })

    // Anomaly watching. A turn that ends in failure is the signal a session is in
    // trouble: it is how an oversized session first shows the symptom, and it is
    // exactly the moment a successor is worth starting. Counting consecutive
    // failures avoids reacting to one transient upstream error.
    yield ctx.on('session/event', (session, event) => {
      try {
        if (event === undefined || event.type !== 'turn/end') return
        const agents = ctx.get('agents')
        const agent = agents === undefined ? undefined : agents.get(session.id)
        if (agent === undefined) return
        const reason = event.data && event.data.reason
        const kind = reason && typeof reason.kind === 'string' ? reason.kind : 'completed'
        if (kind === 'completed') {
          failureStreak.delete(session.id)
          return
        }
        // `aborted` is the user's own stop, and `interrupted` is a crash closer;
        // neither means the session is broken, so neither is an anomaly.
        if (kind === 'aborted' || kind === 'interrupted') return
        const streak = (failureStreak.get(session.id) || 0) + 1
        failureStreak.set(session.id, streak)
        log('turn ended as ' + kind + ' for ' + session.id + ' (consecutive failures: ' + streak + ')')
        if (mayActOn(measure(agent))) maybeAutoHandoff(agent, undefined, { anomaly: kind, streak })
      } catch (error) {
        logError('anomaly observation failed:', (error && error.message) || error)
      }
    })
    log('installed: /handoff registered, pressure monitor active (upstream limit ' + policyNow().upstreamPromptLimit + ')')
  }, 'dsh-session-handoff lifecycle')

  return () => {
    reminderState.clear()
    handoffAttempts.clear()
    autoHandoff.suppressed.clear()
    capacityPending.clear()
    capacityValue.clear()
  }
}
