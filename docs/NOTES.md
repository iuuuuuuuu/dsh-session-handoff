# Engineering notes

[简体中文](./NOTES.zh-CN.md) · **English**

How this plugin was verified, and what went wrong on the way. These notes are the evidence
behind the claims in [the README](../README.md); they are deliberately separate so the README
stays a user-facing document.

## The deadlock, measured

Compaction replays the whole shadowed region as one request. The upstream ceiling on a single
prompt measured **2^20 = 1,048,576 tokens** on this machine's AI Gateway route, established by
cross-checking ASCII against CJK payloads so the byte and token theories could be told apart:

| Payload | Measured | Result |
| --- | --- | --- |
| ASCII 4,175,000 chars | 1,047,005 tokens | 200 |
| ASCII 4,185,000 chars | over the line | 400 |
| CJK 2.00M chars (only 1.91 MiB) | 1,043,489 tokens | 200 |
| CJK 2.10M chars (2.00 MiB) | over the line | 400 |

The CJK row is what settles it: a payload **smaller in bytes** failed, so the limit is on
tokens, not bytes.

## The real poisoned session

`session-9ef22e43` — 193MB, 117,541 events, 32,286 messages — run through the pipeline
read-only:

```
transcript size:           34,631,694 estimated tokens
naive request carries:     34,631,694 tokens
verdict:                   REJECTED (this is the 11133 deadlock)
per-request input budget:     498,400 tokens
verbatim recent turns kept:   35 of 32,286 (trimmed)
seed from the exact layers:   49,052 chars (~15,391 tokens)  ← zero model requests
```

## The automatic trigger, replayed on real data

A dead 106MB session's real 1,316-outcome failure sequence, fed through the mounted plugin:

| Session size | Fired at | Correct? |
| --- | --- | --- |
| 10% of the window | failure #1336, a terminal `model_param_invalid` | yes — terminal codes bypass the volume floor |
| 90% of the window | failure #43, the third consecutive refusal | yes — streak + volume |
| after a success | never | yes — a success resets the streak |

The joint condition exists because of what the same replay showed without it: a policy refusal
(`dsh_compaction_refused`) fired **1,062 times** across one session **that kept working
throughout**. Acting on the count alone would have torn down a healthy session.

## End to end in an isolated host

Run in a separate DSH home on port 3099, with the user's own host untouched:

```
1. plugin activates with no error:           yes
2. settings namespace live:                  yes (16 editable fields)
3. a setting written through the real API:   yes (autoHandoff.atLevel -> watch)
4. two consecutive REAL failed turns:        yes
5. the anomaly trigger fires by itself:      yes (anomaly:error x2)
6. successor created and seeded:             yes (8,701 chars: real facts + verbatim tail)
7. source NOT archived (auto mode):          yes
```

## Bugs only a live host could find

The unit suite was green while the plugin was broken in four separate ways. Each was found by
running it in a real host, and each is now covered by a test.

**1. A volatile group enclosing volatile leaves makes the fiber fail.**

```
ValidationError: invalid config:
  - $.monitor.enabled volatile fields require a fixed object path
    without an enclosing volatile field (at monitor.enabled)
```

Marking a group `.volatile()` *and* its leaves `.volatile()` is the natural mistake. The
consequence is not a warning: the fiber fails validation, and the settings layer only exposes
namespaces whose fiber is **active** — so the Settings page read "this deployment does not
expose this plugin's configuration" while every command kept working.

**2. `turn/end` and `compaction/end` are session appends, not live events.**

The durable event names look like event-bus names, so listening on them compiles, runs, and
never fires. The real hook is `session/event`, which carries every append as
`(session, event)`.

**3. A turn boundary is observed while the driver is still running.**

The append happens inside the driver's own `finally`, so the agent is still `running` at that
instant. Requiring idleness immediately blocked every trigger — the plugin counted failures
correctly and then did nothing. The fix waits for the driver to settle, bounded at 10s.

**4. A session was handed off repeatedly.**

After a successful handoff the next failed turn fired again, and again — **1,313 fires** across
one session's history. A broken session would have forked a successor per turn, which is worse
than the breakage it was rescuing. A successful handoff now suppresses the session, and a
failing one stops after three attempts.

## Why three healthy sessions were forked

An early build handed off three sessions that were **healthy and still working**. The cause was
the measurement, not the triggers:

| Session | What the GUI reported | What the plugin's estimate said |
| --- | --- | --- |
| `2f11ef00` | 76,040 tokens | ~800,000 |
| `e7d70ba3` | 71,120 tokens | ~900,000 |
| `d46b3a4d` | 406,013 tokens | ~1,200,000 |

The plugin read `ctx.tokenMeter.measure(session).totalTokens`, which **prices the whole
surface** — including history an earlier compaction already shadowed. On a session that had
compacted several times, that estimate ran far ahead of the real prompt.

The fix is to read the harness's own `contextPressure` projection, which publishes the
**provider-reported** occupancy — the number that actually decides whether the next request
fits. An estimate may no longer trigger anything at all: every trigger call site is gated, and
a fallback reading is labelled `estimated: true`. An estimate is still good enough to *remind*
you; it is not good enough to take a session away from you.

## Why the model window is read rather than configured

The window was configured by hand, which meant it went stale the moment the session switched
models — and the user had to know a number the harness already knows. An adapter declares each
model's `contextWindow` in its model profile, and `llm.resolveModelInfo(provider, model)`
returns it: the same configuration the request itself is built from.

| Route | Declared window | Pressure | Verdict |
| --- | --- | --- | --- |
| `ai/big-model` | 2,000,000 | 150,000 | **ok** (14%) |
| `ai/small-model` | 200,000 | 150,000 | **critical** (75%) |

The resolution is cached per route and primed in the background so the event observers stay
synchronous. Until a route's capacity resolves, the header's own value is used.

## Redaction, both directions

| Control | Result |
| --- | --- |
| Negative: a real tail, untouched | **0 redactions, byte-identical** |
| Positive: the same tail with 4 credential shapes spliced in | **5 redactions, all 4 values gone** |

The negative control deliberately contains **SHA-256 digests** — they look like keys but are
exactly the evidence a handoff must keep, so they must not be touched.

## Fact-extraction quality

The first version produced junk on a real transcript. Three defects, each fixed and covered:

1. **CJK boundaries.** A Windows path in a real transcript is routinely followed immediately by
   Chinese prose with no separator; the original pattern swallowed the sentence. It now stops
   at CJK punctuation and ideographs.
2. **Recency.** In a 117k-event session the first sixty paths were all ancient history. The cap
   now keeps the **most recent** occurrences.
3. **Generated paths.** One Rust build tree contributed sixty
   `target/debug/build/<crate>-<hash>/out/*` entries and crowded out the source paths. They are
   now collapsed by shape, and source paths outrank build artifacts.

## Measuring what is live is not measuring what is listed

`session/list` returns **live and cold sessions in one array**: it reads the store, and for
anything not in the store it falls back to a cold read of the header from disk. Counting that
array therefore over-reports residency by a wide margin — on this machine it reported 230
sessions when **8** were actually live.

The field that distinguishes them is `agentAvailable`. A measurement of memory residency must
filter on it:

```js
const live = items.filter((s) => s.agentAvailable === true)
```

This matters because the first reading of the release fix claimed "31 archived sessions still
resident, holding 675MB" — which was wrong. The truth was 3 live archived sessions; the other
28 were cold reads of headers, holding nothing. The 675MB was the on-disk log total, not
memory. Both numbers were reported before the error was found, and both are corrected here.

## Releasing a session does not release its agent

A session is held by **two independent registries**, and only one of them is reachable from a
plugin:

| Registry | Holds | Removable? |
| --- | --- | --- |
| `ctx.sessions` | the session's event tree | `sessions.remove(id)` — yes |
| `ctx.agents` | the agent, which holds `agent.session` | **no public path** |

The agent registry's store is a plain `new Map()` (a strong reference). `agents.enter()`
returns the detach disposer, but `enter()` is called by the agent loop, not by a plugin;
neither `agents.remove` nor `agent.dispose` appears on the public surface, and the factory's
`dispose()` tears down **every** agent rather than one.

Measured with a real `SessionStore` and a real `AgentRegistry`:

```
BEFORE release:  sessions.get(id) -> true    agents.get(id) -> true
AFTER  release:  sessions.get(id) -> false   agents.get(id) -> true
                 the agent still carries all events
```

So the release step frees the session store's reference and nothing else. A plugin cannot free
the rest without a harness change: `ctx.agents` would need a public per-id removal, or the
agent loop would need to expose the disposer it already holds.

Two earlier claims are corrected here: the release step was described as freeing memory (it
frees half), and the residency measurement that motivated it counted cold reads (see above).

## Reproducing the checks

```sh
node --test tests/smoke.test.mjs        # 69 tests
node tests/auto-trigger-real.mjs        # replay a real failure sequence
node tests/client-render.mjs            # render the settings page
node tests/e2e-real-session.mjs <log>   # read-only probe on a real transcript
```

The 6.4MB session fixture is **not committed** — it is private conversation content. Rebuild it
locally with `tests/make-fixture.mjs`.
