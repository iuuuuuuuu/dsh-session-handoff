# Delivery notes · dsh-session-handoff 0.1.0

[简体中文](./DELIVERY.md) · **English**

## In one line

A DSH plugin that hands a conversation's memory to a fresh session **before** the old one
becomes unusable, and rescues sessions that already are.

The successor inherits **four** layers of memory (verbatim facts / earlier checkpoints / the
recent turns word for word / a chunked summary), and **no assembled summarization request can
exceed the upstream token ceiling** — which is what makes it work on a session that is already
over the limit.

## Deliverables

| Path | What it is |
| --- | --- |
| `lib/` | The plugin (7 modules) |
| `tests/` | 69 tests, a real-sequence replay, a render test, and a fixture rebuilder |
| `docs/NOTES.md` | **Engineering notes**: how it was verified, and what went wrong on the way |
| `README.md` | The full user-facing documentation |

Install, use, configuration, and "what it cannot do" all live in the [README](./README.md).

## Install state

- Installed into the `tauri` profile as a link:
  `"dsh-session-handoff": "link:D:/WishProject/dsh-session-handoff/"`
- Registered in `dsh.profile.bundles`
- Commands confirmed live through `POST /api/commands/list`: `handoff` and `handoff-status`
- Published to GitHub (public): <https://github.com/iuuuuuuuu/dsh-session-handoff>, carrying the
  `dsh-plugin` topic

## Restart DSH for changes to take effect

The harness keeps loaded plugin modules in its loader cache and `hmr.root` defaults to `[]`,
so editing a plugin's source does **not** take effect in a running host. A config reload
re-reads the profile patch but re-uses the already-evaluated module.

## Verification commands

```sh
node --test tests/smoke.test.mjs        # 69 tests
node tests/auto-trigger-real.mjs        # replay a real failure sequence
node tests/client-render.mjs            # render the settings page
node tests/e2e-real-session.mjs <log>   # read-only probe on a real transcript
```

## What it cannot do, stated plainly

- **It does not shrink the live session.** Handoff moves work to a new session; the old one
  stays on disk (archived, still readable).
- **The summary is a paraphrase.** Exact recall comes from the facts and checkpoints layers and
  from the archived session, which stays openable.
- **`upstreamPromptLimit` is a guess until you measure it.** It is the one ceiling that cannot
  be read from anywhere — the model window is now read from the session's model configuration.
- **The automatic triggers have not fired on a naturally occurring failure yet.** The logic is
  verified against real data and in an isolated host, but that moment is still unobserved.

## Where the evidence is

The measured numbers, the four bugs only a live host could find, the redaction controls, and
the fact-extraction iterations all live in the [engineering notes](./docs/NOTES.md). These
delivery notes keep only "what was installed, how it was verified, and what to watch for".
