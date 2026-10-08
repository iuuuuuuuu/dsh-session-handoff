# Delivery notes · dsh-session-handoff 0.1.0

[简体中文](./DELIVERY.zh-CN.md) · **English**

## In one line

A DSH plugin that hands a conversation's memory to a fresh session **before** the old one
becomes unusable, and rescues sessions that already are.

## The deadlock it breaks

Compaction replays the **whole shadowed region** as one request. The upstream ceiling on a
single prompt is **2^20 = 1,048,576 tokens** (measured on this machine's route). Once a
session passes it, the compaction request is *itself* over the ceiling — so compaction fails
with the overflow it was meant to cure, forever. Naive handoff plugins build their request
the same way, so they fail too. That is the deadlock.

## Deliverables

| Path | What it is |
| --- | --- |
| `lib/index.js` | Plugin entry: `/handoff`, `/handoff-status`, pressure monitor, three triggers |
| `lib/client.js` | Settings page (browser half), built from the app's design tokens |
| `lib/handoff.js` | The transaction: read → memory → summarize → create → deliver → archive → release |
| `lib/memory.js` | Layered extraction (facts, checkpoints, verbatim tail) + redaction + seed assembly |
| `lib/summarize.js` | Bounded map-reduce summarization |
| `lib/pressure.js` | Classification, reminder policy, the joint compaction condition |
| `lib/token-budget.js` | Token estimation and per-request budgeting |
| `tests/smoke.test.mjs` | 67 tests covering every module |
| `tests/auto-trigger-real.mjs` | Replays a real failure sequence through the mounted plugin |
| `tests/client-render.mjs` | Renders the settings page with a faithful jsx-runtime stub |
| `tests/make-fixture.mjs` | Rebuilds the local fixture from a real session log |
| `README.md` / `README.zh-CN.md` | Full documentation, both languages |
| `DELIVERY.md` / `DELIVERY.en.md` | These notes, both languages |

## Measured, not assumed

### The invariant that makes it safe

A synthetic 20M-token transcript is fed through the assembler and asserted to produce
requests that are each within budget. This is why the plugin works on a session that is
**already over the limit** — the situation every other approach fails in.

### The real poisoned session

A 193MB session (`9ef22e43`, 117,541 events, 32,286 messages, 34,631,694 estimated tokens)
that the naive path rejects outright:

```
transcript size:           34,631,694 tokens
naive request carries:     34,631,694 tokens
verdict:                   REJECTED  ← the old approach always fails here
per-request input budget:     498,400 tokens
verbatim recent turns kept:   35 of 32,286
exact-layer seed:             49,052 chars (~15,391 tokens)  ← zero model requests
```

### Redaction, both directions

| Control | Result |
| --- | --- |
| Negative: a real tail, untouched | **0 redactions, byte-identical** |
| Positive: the same tail with 4 credential shapes spliced in | **5 redactions, all 4 values gone** |

The negative control deliberately contains **SHA-256 digests** — they look like keys but are
exactly the evidence a handoff must keep, so they must not be touched.

### The automatic trigger, on real data

Replaying the real 1,316-outcome failure sequence from a dead 106MB session:

| Session size | Fired at | Correct? |
| --- | --- | --- |
| 10% of the window | failure #1336, a terminal `model_param_invalid` | yes — terminal codes bypass the volume floor |
| 90% of the window | failure #43, the third consecutive refusal | yes — streak + volume |
| after a success | never | yes — a success resets the streak |

### End to end in an isolated host

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

## Credentials

The verbatim layer is a copy, so anything the session once echoed would be copied too. A
handoff seed is a new artifact that may be read or shared, so it is redacted by shape before
it is written: bearer tokens, `sk-` / `ghp_` / `github_pat_` / `xox` / `AKIA` keys, JWTs,
PEM private keys, `password=` assignments, and inline connection-string passwords. The fact
layer is redacted too, since a path can embed a secret.

## Install state

Installed into the `tauri` profile as a link:

```
D:\DSHHome\profiles\tauri\package.json
  "dsh-session-handoff": "link:D:/WishProject/dsh-session-handoff/"
```

and registered in `dsh.profile.bundles`. `/handoff` and `/handoff-status` are confirmed live
through `POST /api/commands/list`.

Published to GitHub (public): <https://github.com/iuuuuuuuu/dsh-session-handoff>, carrying the
`dsh-plugin` topic.

## Restart DSH for changes to take effect

The harness keeps loaded plugin modules in its loader cache and `hmr.root` defaults to `[]`,
so editing a plugin's source does **not** take effect in a running host. A config reload
re-reads the profile patch but re-uses the already-evaluated module.

## Verification commands

```sh
node --test tests/smoke.test.mjs        # 67 tests
node tests/auto-trigger-real.mjs        # replay the real failure sequence
node tests/client-render.mjs            # render the settings page
node tests/e2e-real-session.mjs <log>   # read-only probe on a real transcript
```

## What it cannot do, stated plainly

- **It does not shrink the live session.** Handoff moves work to a new session; the old one
  stays on disk (archived, still readable) until you delete it.
- **The summary is a paraphrase.** Exact recall comes from the facts and checkpoints layers
  and from the archived session, which stays openable.
- **`upstreamPromptLimit` is a guess until you measure it.** It is the one ceiling that cannot be
  read from anywhere — the model window is now read from the session's model configuration — so
  the default is what this machine's route measured; another account may differ.
- **The automatic triggers have not fired on a real, naturally occurring failure yet.** The
  logic is verified against real sequences and in an isolated host with a deliberately broken
  route, but "the user's own session broke and the plugin moved it" is still unobserved.
