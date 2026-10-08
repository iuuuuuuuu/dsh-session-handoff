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
- The upstream provider enforces a hard ceiling on one request's prompt.
- Once the session passes that ceiling, the compaction request *is itself* over the ceiling.
- So compaction fails with the same overflow it was supposed to cure, every time, forever.

The session then cannot be compacted, cannot be continued, and — because the naive handoff
implementations build their summarization request the same way — cannot be handed off either.
That is the deadlock. `/handoff` exists to break it.

## Install

```sh
dsh plugin --profile <name> add /path/to/dsh-session-handoff
```

If your profile's `cordis.patch.yml` already mounts this plugin by hand, remove that row
first, or you will run two instances.

**Restart DSH.** This is required, not optional: the harness keeps loaded plugin modules in
its loader cache, and `hmr.root` defaults to `[]`, so editing a plugin's source does **not**
take effect in a running host.

After restarting, the log shows:

```
[session-handoff] installed: /handoff registered, pressure monitor active (upstream limit 1048576)
```

## Use

```
/handoff           hand this conversation off to a fresh session
/handoff-status    show the measurement, the binding ceiling, and the trigger state
```

`/handoff` prints a report:

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

## What it does

### It watches

At every **turn boundary** the plugin measures the session's token pressure and classifies it
against **two** independent ceilings, binding on whichever is tighter:

| Ceiling | Where it comes from | Why it matters |
| --- | --- | --- |
| The model's context window | read from the model configuration the session is using | what the model itself accepts |
| The upstream prompt limit | configured, because nothing declares it | what the provider accepts on **one request** |

The second is the one that actually kills sessions, and it is *not* derivable from the first —
a routed model may advertise a 1,000,000-token window while the account behind it enforces
less on a single request.

When pressure crosses the policy ladder the plugin injects a **notice** into the session
naming the measured number, the binding ceiling, and the way out. A notice is model-facing
context for the next step, so it **never starts a turn on its own**, and it is rate-limited on
both growth and time so a session parked at `critical` does not nag.

### It hands off

`/handoff` runs one transaction:

```
1. read        the live session (messages + events)
2. memory      extract four layers of memory
3. summarize   bounded map-reduce, one request per chunk
4. create      the successor, inheriting the source's route and cwd
5. deliver     the seed as the successor's opening turn
6. archive     the source, with stopActivity — its work is terminated
7. release     drop the source's live event tree
```

**The successor starts working immediately.** The seed is not a note for you to read; it is
delivered as the successor's first turn, so the new session picks the work up and continues.

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
seed budget rather than competing with prose for the leftovers, because facts give you the
paths while only the tail gives you the exact thought you were mid-way through.

### Credentials never ride along

The verbatim layer is a *copy*, so anything the session once echoed — a token printed while
debugging, a key in a dotenv dump — would be copied too. A handoff seed is a new artifact that
may be read or shared, so it is redacted by shape before it is written: bearer tokens, `sk-` /
`ghp_` / `github_pat_` / `xox` / `AKIA` keys, JWTs, PEM private keys, `password=`-style
assignments and inline connection-string passwords. The fact layer is redacted too, since a
path can embed a secret.

## Automatic handoff

Automatic handoff is **on by default**; automatic archiving is **off**.

The distinction is the point: handing off creates a successor that keeps working, while
archiving *hides* the session that broke. When a session dies while you are away, that session
is evidence — you want to see what it was doing, not find it gone.

Three independent triggers, because a session can become unusable in three different ways:

| Trigger | Signal | Default |
| --- | --- | --- |
| **Pressure** | measured pressure reaches `atLevel` | `critical` |
| **Failed turns** | a run of consecutive failed turns | 2 |
| **Compaction failure** | a failure streak **and** enough volume | 3 failures, 35% of the window |

Only `error` and `max-tokens` turn endings count as failures. `completed` resets the streak;
`aborted` (your own stop) and `interrupted` (a crash closer) are **not** failures, because
neither means the session is broken.

**The compaction trigger is deliberately a joint condition.** A compaction failure is not
judged on its own: a policy refusal can repeat hundreds of times on a session that is working
fine, so the count alone would tear down healthy sessions. It requires both a failure streak
**and** volume. A *terminal* code (the request no longer fits at any size) bypasses the volume
floor, and a platform-level pool failure is deliberately **not** a trigger, because a handoff
cannot fix a fault the successor would inherit.

A session is handed off **at most once**. A successful handoff suppresses that session for the
rest of the process; a failing one stops after three attempts and tells you to run `/handoff`
by hand.

## Configuration

Mount config in your profile patch, or edit it live in **Settings → 会话交接 / Session handoff**:

```yaml
- id: session-handoff
  name: 'dsh-session-handoff'
  config:
    monitor:
      enabled: true
    policy:
      upstreamPromptLimit: 1048576       # fallback for routes with no entry
      upstreamPromptLimits:              # per-route measured ceilings
        ai/deepseek-v4.1-flash: 1048576
      watchRatio: 0.45
      warnRatio: 0.6
      criticalRatio: 0.75
      remindEveryTokens: 50000
      remindCooldownMs: 600000
      seedBudgetTokens: 24000
    autoHandoff:
      enabled: true
      atLevel: critical
      onAnomaly: true
      anomalyThreshold: 2
      archive: false
```

The **model window is not configured** — the plugin reads it from the model configuration the
session is actually using, so it follows a model switch with no setting touched. Only the
**upstream prompt limit** stays configured: it is a property of the account behind a route, it
appears in no model configuration, and measurement is the only authority on it.

## Guarantees

Asserted by the test suite (`node --test tests/smoke.test.mjs`):

- **No assembled summarization request can exceed its budget** — the invariant that makes the
  plugin safe on a session that is already over the limit.
- **Redaction is neither blind nor over-eager**: a clean tail passes through byte-identical
  (including SHA-256 digests, which look like secrets but are evidence worth keeping), while
  the same tail with credentials spliced in has every one removed.
- Facts and checkpoints survive even when the prose layer cannot fit.
- Hidden reasoning never leaks into the seed.
- An **estimated** reading can remind you but can never trigger an automatic handoff.
- The settings page renders every label in both languages, and every colour in its stylesheet
  comes from a design token.

## Limits, stated plainly

- **It does not shrink the live session.** Handoff moves work to a new session; the old one
  stays on disk (archived, still readable) until you delete it.
- **The summary is a paraphrase.** Exact recall comes from the facts and checkpoints layers and
  from the archived session, which remains openable.
- **`upstreamPromptLimit` is a guess until you measure it.** It is the one ceiling that cannot
  be read from anywhere, so the default is what this machine's route measured.
- **Map-reduce costs one request per chunk.** On a very large session that is tens of requests;
  the report tells you how many.
- **Archiving is not deletion.** It removes the session from the sidebar's default view.
- **The automatic triggers have not fired on a naturally occurring failure yet.** The logic is
  verified against real data and in an isolated host, but that moment is still unobserved.

## Layout

```
lib/
  index.js         plugin entry: commands, pressure monitor, triggers
  client.js        settings page (browser half)
  handoff.js       the transaction
  memory.js        layered extraction + redaction + seed assembly
  summarize.js     bounded map-reduce summarization
  pressure.js      classification, reminder policy, the joint compaction condition
  token-budget.js  token estimation and request budgeting
tests/
  smoke.test.mjs           unit tests for every module
  auto-trigger-real.mjs    replays a real failure sequence through the plugin
  client-render.mjs        renders the settings page with a faithful jsx-runtime stub
  e2e-real-session.mjs     read-only probe on a real transcript
  make-fixture.mjs         rebuilds the local fixture from a real session log
docs/
  NOTES.md                 how this was verified, and what went wrong on the way
```

## Documentation

| File | Language |
| --- | --- |
| `README.md` | English |
| `README.zh-CN.md` | 简体中文 |
| `docs/NOTES.md` | English — engineering notes and verification evidence |
| `docs/NOTES.zh-CN.md` | 简体中文 — 同上 |
| `DELIVERY.md` | 简体中文 |
| `DELIVERY.en.md` | English |

## License

MIT
