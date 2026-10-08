[![dsh-plugin](https://img.shields.io/badge/dsh--plugin-yes-4b6bfb)](https://github.com/iuuuuuuuu/dsh-session-handoff)
[![license](https://img.shields.io/badge/license-MIT-2ea44f)](./LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D22.15-339933)](https://nodejs.org)

# dsh-session-handoff

**English** · [简体中文](./README.zh-CN.md)

Carry a conversation's memory into a new session **before** the old one becomes unusable.

## The problem this solves

A long DSH session eventually reaches a size where its own compaction stops working. The
mechanism is worth stating precisely, because it is what makes the failure permanent:

- Compaction replays the **whole shadowed region** as the input to one summarization request.
- The upstream provider enforces a hard ceiling on one request's prompt (measured at
  **2^20 = 1,048,576 tokens** on the AI Gateway route).
- Once the session passes that ceiling, the compaction request *is itself* over the ceiling.
- So compaction fails with the same overflow it was supposed to cure, every time, forever.

The session then cannot be compacted, cannot be continued, and — because the naive handoff
implementations build their summarization request the same way — cannot be handed off either.
That is the deadlock. `/handoff` exists to break it.

## What it does

Two things.

### 1. It watches

At every turn boundary the plugin measures the session's real token pressure through the
harness token meter and classifies it against **two** independent ceilings:

| Ceiling | Why it matters |
| --- | --- |
| The model's advertised context window | What the model itself accepts |
| The upstream prompt limit | What the provider accepts on one request |

The second is the one that actually kills sessions, and it is *not* derivable from the first —
a routed model may advertise a 1,000,000-token window while the account behind it enforces
1,048,576 on a single request. When pressure crosses the policy ladder the plugin injects a
reminder into the session naming the measured number, the binding ceiling, and the way out.

Reminders are rate-limited on both growth and time, so a session parked at `critical` does not
nag on every step.

### 2. It hands off

`/handoff` runs one transaction:

1. **Read** the live session's messages and events.
2. **Extract** four layers of memory (below).
3. **Summarize** the transcript with map-reduce — every request independently bounded.
4. **Create** a successor session and deliver the seed as its opening turn.
5. **Archive** the source session, last.

### The memory it carries

The design question is *what to carry*. Four layers, ordered by cost:

| Layer | Source | Fidelity | Cost |
| --- | --- | --- | --- |
| **Verbatim facts** | Regex extraction over the transcript | Exact | Free |
| **Earlier checkpoints** | Successful `compaction/end` summaries the session already wrote | Exact | Free |
| **Recent turns, verbatim** | The tail of the conversation, word for word | Exact | Free |
| **Narrative summary** | Model-written, map-reduce | Paraphrase | One pass |

The three exact layers are never dropped to make room for the paraphrase: only the narrative
layer is truncated, and only from its middle. The verbatim tail gets a *reserved share* of the
seed budget (`recentShareRatio`) rather than competing with prose for the leftovers, because
facts give you the paths while only the tail gives you the exact thought you were mid-way
through. On a 34.6M-token transcript the exact layers produced a ~15,000-token seed: 240
extracted facts, plus the last 35 exchanges word for word.

### Credentials never ride along

The verbatim layer is a *copy*, so anything the session once echoed — a token printed while
debugging, a key in a dotenv dump — would be copied too. A handoff seed is a new artifact that
may be read or shared, so it is redacted by shape before it is written: bearer tokens, `sk-` /
`ghp_` / `github_pat_` / `xox` / `AKIA` keys, JWTs, PEM private keys, `password=`-style
assignments and inline connection-string passwords. Redaction is applied to the fact layer as
well, since a path can embed a secret.

Fact extraction is tuned for real transcripts:

- **Recency wins.** A 117k-event session has thousands of stale paths; the ones a successor
  needs are the ones touched lately, so the cap keeps the most recent occurrences.
- **Generated paths collapse.** Forty `target/debug/build/ai-gateway-core-<hash>/out/*` entries
  are one shape, not forty facts.
- **Source outranks artifacts.** `src/host/rpc.ts` is worth more than a build directory.
- **CJK-aware boundaries.** In real transcripts a Windows path is routinely followed
  immediately by Chinese prose with no separator; the patterns stop at CJK punctuation rather
  than swallowing it.

## Install

```sh
dsh plugin --profile <name> add /path/to/dsh-session-handoff
```

If your profile's `cordis.patch.yml` already mounts this plugin by hand, remove that row
first, or you will run two instances.

**Restart DSH.** This is required, not optional: the harness keeps loaded plugin modules in
its loader cache, and `hmr.root` defaults to `[]`, so editing a plugin's source does **not**
take effect in a running host. A config reload re-reads the profile patch but re-uses the
already-evaluated module.

After restarting, the log shows:

```
[session-handoff] installed: /handoff registered, pressure monitor active (upstream limit 1048576)
```

Confirm it is live without guessing — ask the host for its command registry:

```sh
# via the harness RPC surface
POST /api/commands/list  {"agentId":"<session-id>"}
# /handoff must appear in the returned names
```

## Use

```
/handoff
```

You get a report:

```
Handed off `session-9ef22e43-…` to `session-e7d70ba3-…`.

- read: 32286 messages, 117541 events
- memory: 240 facts, 0 checkpoints
- summarize: 70 chunk(s), source=map-reduce, 18422 chars
- seed: 21544 chars (~5386 tokens)
- create: session-e7d70ba3-…
- archive: session-9ef22e43-…

The source session is archived; it stays readable in the sidebar.
```

The source is archived **last**, so a failure anywhere earlier leaves it intact and usable.

## The two behaviours you asked about

### Reminding

The monitor runs at every turn boundary and measures the session through the harness
token meter. It classifies against **two** ceilings and binds on whichever is tighter:

| Ceiling | What it is | Why it matters |
| --- | --- | --- |
| Model window | what the model itself accepts | the obvious one |
| Upstream prompt limit | what the provider accepts on **one request** | **this is the one that kills sessions**, and it is not derivable from the model window |

The reminder is delivered as a **notice** — a user message whose source declares
`form: 'notice'` plus a one-line summary. That is the harness's own vocabulary for
"this happened, show it in the transcript", and it is what the model-switch row and the
plan-mode row use. It goes in through `agent.inject`, which is model-facing context for
the next pre-step and **does not wake the driver**, so the reminder never starts a turn.

Rate limiting is deliberate: a *level change* always speaks once, but repeating the same
level requires **both** a cooldown (default 10 minutes) **and** real growth (default
50,000 tokens). Without that, a session parked at `critical` would nag on every step and
the owner would learn to ignore it.

### Archiving

**Automatic handoff is ON by default; automatic archiving is OFF.** The distinction is the
point: handing off creates a successor that keeps working, while archiving *hides* the
session that broke. When a session dies while you are away, that session is evidence — you
want to see what it was doing, not find it gone.

```yaml
config:
  autoHandoff:
    enabled: true           # default: true
    atLevel: critical       # default: critical
    onAnomaly: true         # default: true
    anomalyThreshold: 2     # default: 2
    archive: false          # default: false — keep the source visible
```

Manual `/handoff` always archives, because you asked for it and you are watching. It
archives **last**, after the successor exists and the seed has been delivered, so a failure
anywhere earlier leaves the source intact and usable.

### The compaction trigger is a JOINT condition

A compaction failure is an anomaly, but it is **never judged on its own**, and the reason is
measured rather than assumed. Replaying a real session's history:

| Signal | Observed | Why it alone is not enough |
| --- | --- | --- |
| `dsh_compaction_refused` | **1062 times** in one session, which kept working throughout | A policy refusal, not a broken session |
| `context_length_exceeded` | once, at the very end | The request no longer fits at any size |
| `model_param_invalid` | 9 times, all in the final stretch | Same: terminal |

So the trigger requires **both** a failure streak **and** volume:

```
streak >= compactionFailureThreshold        (default 3)
AND pressure / modelWindow >= compactionAnomalyVolumeRatio   (default 0.35)
```

A **terminal** code (`context_length_exceeded`, `model_param_invalid`) bypasses the volume
floor, because there is no size at which the request would be accepted again. And
`no_healthy_account` is **deliberately not a trigger**: it is a platform-level pool
exhaustion, so every session on that route fails identically and a handoff would archive a
working session to fix a fault the successor inherits.

Verified by replaying the real 1,316-outcome failure sequence from a dead 106MB session
through the mounted plugin:

| Session size | Fired at | Correct? |
| --- | --- | --- |
| 10% of the window | failure #1336, a terminal `model_param_invalid` | yes — a terminal code bypasses the volume floor |
| 90% of the window | failure #43, the third consecutive refusal | yes — streak + volume |
| after a success | never | yes — a success resets the streak |

### Three bugs only a live host could find

The unit suite was green while the plugin was broken in three separate ways. Each was
found by running it in a real host, and each is now covered by a test.

**1. A volatile group enclosing volatile leaves makes the fiber fail.**

```
ValidationError: invalid config:
  - $.monitor.enabled volatile fields require a fixed object path
    without an enclosing volatile field (at monitor.enabled)
```

Marking a group `.volatile()` *and* its leaves `.volatile()` is the natural mistake. The
consequence is not a warning: the fiber fails validation, and the settings layer only
exposes namespaces whose fiber is **active** — so the Settings page read "this deployment
does not expose this plugin's configuration" while every command kept working.

**2. `turn/end` and `compaction/end` are session appends, not live events.**

The durable event names look like event-bus names, so listening on them compiles, runs,
and never fires. The real hook is `session/event`, which carries every append as
`(session, event)`. Two watchers read `turn/end` and one reads `compaction/end` through it.

**3. A turn boundary is observed while the driver is still running.**

The append happens inside the driver's own `finally`, so the agent is still `running` at
that instant. Requiring idleness immediately blocked every trigger — the plugin counted
failures correctly and then did nothing. The fix waits for the driver to settle, bounded
at 10s, and defers rather than blocks when a session is genuinely busy.

### A session is handed off at most once

Replaying the real failure sequence exposed a fourth problem: after a successful handoff,
the next failed turn fired again, and again — **1,313 fires** across one session's history.
A broken session would fork a successor per turn, which is worse than the breakage it was
rescuing. Two guards fix it:

- a successful handoff **suppresses** that session for the rest of the process;
- a handoff that **fails** stops after `AUTO_HANDOFF_MAX_ATTEMPTS` (3) and logs that the
  owner should run `/handoff` by hand.

### Why three healthy sessions were forked

An early build handed off three sessions that were **healthy and still working**. The
cause was the measurement, not the triggers:

| Session | What the GUI reported | What the plugin's estimate said | Verdict |
| --- | --- | --- | --- |
| `2f11ef00` | 76,040 tokens | ~800,000 | ok (7.6%) |
| `e7d70ba3` | 71,120 tokens | ~900,000 | ok (7.1%) |
| `d46b3a4d` | 406,013 tokens | ~1,200,000 | ok (40.6%) |

The plugin read `ctx.tokenMeter.measure(session).totalTokens`, which **prices the whole
surface** — including history an earlier compaction already shadowed. On a session that
had compacted several times, that estimate ran far ahead of the real prompt.

**The fix is to read the harness's own `contextPressure` projection**, which publishes
the **provider-reported** occupancy — the number that actually decides whether the next
request fits. And an estimate may no longer trigger anything at all:

- the projection is the primary source; the meter is only a fallback;
- a fallback reading is **labelled** `estimated: true`;
- every trigger call site is gated on `mayActOn(measured)`, which excludes estimates.

An estimate is still good enough to *remind* you. It is not good enough to take a session
away from you.

### The upstream limit is per model

The ceiling a provider enforces on one request differs by model, so the policy carries a
map:

```yaml
config:
  policy:
    upstreamPromptLimit: 1048576       # fallback for routes with no entry
    upstreamPromptLimits:
      ai/deepseek-v4.1-flash: 1048576
      zcode/GLM-5.3-Flash: 500000
```

A route entry takes precedence; an unlisted route uses the scalar. The Settings UI edits
the map as `provider/model = tokens` lines, and the classification names the limit it
actually used (`effectiveLimit`), so a reading is never ambiguous about its ceiling.

### The model window is read, not configured

The ceiling must follow the model the session is actually using. An adapter declares each
model's `contextWindow` in its model profile, and the plugin reads it through
`llm.resolveModelInfo(provider, model)` — the same configuration the request itself is
built from. Switching models therefore switches the ceiling, with no plugin setting touched:

| Route | Declared window | Pressure | Verdict |
| --- | --- | --- | --- |
| `ai/big-model` | 2,000,000 | 150,000 | **ok** (14%) |
| `ai/small-model` | 200,000 | 150,000 | **critical** (75%) |

The resolution is cached per route and primed in the background, so the observers stay
synchronous. Until a route's capacity has resolved, the header's own value is used.

Only **one** ceiling stays configured: the **upstream prompt limit**. It is a property of the
ACCOUNT behind a route rather than of the model, it appears in no model configuration, and
measurement is the only authority on it. `upstreamPromptLimits` overrides it per
`provider/model`.

### The Settings UI

`Settings → 会话交接 / Session handoff` exposes every policy field live. Changes are written
as path operations into this plugin's own namespace in the profile patch, and the plugin
re-reads its policy on each observation, so a change takes effect on the next turn rather
than requiring a restart.

The form only appears when the profile actually mounts the plugin's row, because settings
addresses a namespace by Loader entry id.

When armed, three gates must all hold before it fires: pressure is at the configured
level, the session is idle (the hook is a turn boundary, so no turn is open), and no
handoff is already running for that session.

Inspect the state at any time with `/handoff-status`, which reports the measurement, the
binding ceiling, whether a reminder is due, and whether automatic handoff is armed.

## Handing off mid-conversation

### What "anomaly" means here

Automatic handoff has **two independent triggers**, because a session can become
unusable in two different ways:

| Trigger | Signal | Default |
| --- | --- | --- |
| **Pressure** | measured context pressure reaches `atLevel` | `critical` |
| **Anomaly** | a run of **consecutive failed turns** | 2, via `anomalyThreshold` |

The pressure trigger is the slow one. The anomaly trigger is the fast one and catches a
session that is broken well below the pressure line — a session whose turns keep failing is
already unusable regardless of how many tokens it holds.

Only `error` and `max-tokens` turn endings count. `completed` resets the streak;
`aborted` (your own stop) and `interrupted` (a crash closer) are **not** anomalies, because
neither means the session is broken.

Both triggers are gated the same way: pressure/streak reached, no handoff already running
for that session, and the agent is not inside a turn.

### What it does when it fires

```
1. read        the live session (messages + events)
2. memory      extract facts, checkpoints, and the verbatim recent tail
3. summarize   bounded map-reduce, one request per chunk
4. create      the successor, inheriting the source's route and cwd
5. deliver     the seed as the successor's opening turn
6. archive     the source, with stopActivity — its work is terminated
7. release     drop the source's live event tree
```

**The successor starts working immediately.** The seed is not a note for you to read; it is
delivered as the successor's first turn, so the new session picks the work up and continues.
The report says so:

```
Handed off `session-3abd9fb1-…` to `session-1f9e608b-…`.
- read: 5 messages, 20 events
- memory: 3 facts, 0 checkpoints
- summarize: 1 chunk(s), source=single-pass, 6642 chars
- recent: 5 verbatim message(s)
- seed: 12114 chars (~4067 tokens)
- create: session-1f9e608b-…
- archive: session-3abd9fb1-… (work stopped)
- release: live event tree dropped for session-3abd9fb1-…

The source session is archived; it stays readable in the sidebar.
Its live event tree was released, so it no longer occupies memory.
```

### Terminating the old session

Archiving a session that is **mid-turn** is refused by the harness. The handoff therefore
passes `stopActivity: true`, which makes the registry ask every `workspace/session-stop`
provider to stop the session's work. The agent provider answers by calling
`agent.cancel({ kind: 'user' })` — **exactly what your own stop button does**, minus
`keepInbox`, so queued input is discarded rather than waking the archived session later.

### Does archiving remove anything? **No — and that is why the release step exists.**

Archiving is purely a **visibility** change:

- the session id joins the registry-global archive set, which hides it from the sidebar's
  default view;
- its workspace accounting slot is **kept**, so unarchiving restores its exact position;
- its pin is dropped in the same durable write (pinning and archived are mutually exclusive);
- **nothing is deleted.** The durable log on disk is untouched, and the session stays
  readable — you can unarchive it at any time.

Measured after a real handoff: the source was archived, and its log was still on disk
(`…\session-3abd9fb1-…\session.v4.jsonl.zstd`, 28,227 bytes) and still openable.

But archiving does **not** free memory either. The live event tree is held by the session
store, and for a very large session that tree is the expensive part. So the handoff adds a
**release** step: `SessionStore.remove(id)` runs the store's official detach lifecycle,
dropping the session from the live set while its durable log stays on disk.

The release is deliberately careful: it refuses to drop a session whose own agent is still
`running` (removing it then would race the driver's closing events), and a store that
refuses the removal leaves the handoff **successful** with a reported warning rather than
failing it. If you want to read the archived session again, DSH re-opens it from disk.

## Configuration

Mount config in your profile patch:

```yaml
- id: session-handoff
  name: 'dsh-session-handoff'
  config:
    monitor:
      enabled: true
    policy:
      upstreamPromptLimit: 1048576
      watchRatio: 0.45
      warnRatio: 0.6
      criticalRatio: 0.75
      remindEveryTokens: 50000
      remindCooldownMs: 600000
      seedBudgetTokens: 24000
```

`upstreamPromptLimit` is configuration rather than a computed value on purpose: it is a
property of the account behind the route, and the only authority on it is measurement.

## Guarantees

These are asserted by the test suite (`node --test tests/smoke.test.mjs`):

- **No assembled summarization request can exceed its budget**, verified against a synthetic
  20M-token transcript. This is the invariant that makes the plugin safe on a session that is
  already over the limit.
- **Redaction is neither blind nor over-eager**: a clean transcript tail passes through
  byte-identical — including SHA-256 digests, which look like secrets but are the evidence a
  handoff must keep — while the same tail with credentials spliced in has every one removed.
- Facts and checkpoints survive even when the prose layer cannot fit.
- Hidden reasoning never leaks into the seed.
- A level change always speaks once; repeating requires both a cooldown and real growth.
- Route resolution prefers the live request header over agent defaults, and survives a header
  that throws.
- The installed entry point imports cleanly in a fresh process, and the full
  read → memory → summarize → create → archive pipeline runs against a stub host with a stub
  model, asserting that the seed carries the real path, the earlier checkpoint, the model
  summary and the error code — and that the source is archived exactly once.

## Limits, stated plainly

- **It does not shrink the live session.** Handoff moves work to a new session; the old one
  stays on disk (archived, still readable) until you delete it.
- **The summary is a paraphrase.** Exact recall comes from the facts and checkpoints layers
  and from the archived session, which remains openable.
- **`upstreamPromptLimit` is a guess until you measure it.** It is the one ceiling that cannot be
  read from anywhere, so the default is what this machine's route measured. The model window,
  by contrast, is read from the model configuration and needs no setting.
- **Map-reduce costs one request per chunk.** On a very large session that is tens of requests;
  the report tells you how many.
- **Archiving is not deletion.** It removes the session from the sidebar's default view.

## Layout

```
lib/
  index.js         plugin entry: /handoff command + pressure monitor
  handoff.js       the transaction: read → memory → summarize → create → archive
  memory.js        layered extraction (facts, checkpoints, verbatim tail) + redaction + seed assembly
  summarize.js     bounded map-reduce summarization
  pressure.js      classification, reminder policy, reminder text
  token-budget.js  token estimation and request budgeting
  client.js        settings page (browser half)
tests/
  smoke.test.mjs           unit tests for every module
  auto-trigger-real.mjs    replays a real failure sequence through the plugin
  client-render.mjs        renders the settings page with a faithful jsx-runtime stub
  e2e-real-session.mjs     read-only probe that runs the pipeline on a real transcript
  make-fixture.mjs         rebuilds the local fixture from a real session log
```

## Documentation

| File | Language |
| --- | --- |
| `README.md` | English |
| `README.zh-CN.md` | 简体中文 |
| `DELIVERY.md` | 简体中文 |
| `DELIVERY.en.md` | English |

## License

MIT
