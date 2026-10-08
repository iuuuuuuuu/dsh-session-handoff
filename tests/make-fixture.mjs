#!/usr/bin/env node
/**
 * Regenerate the real-session fixtures used by the auto-trigger test.
 *
 * The trimmed session is NOT committed: it is 18MB of the user's own conversation
 * content. This script rebuilds it from a full session log, keeping the head of the
 * conversation plus the tail around the failure storm, so the trigger can be tested
 * against real event shapes without shipping private data.
 *
 * Usage:
 *   node tests/make-fixture.mjs "<DSH_HOME>/sessions/<workspace>/<session>/session.v4.jsonl.zstd"
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zstdDecompressSync } from 'node:zlib'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const here = dirname(fileURLToPath(import.meta.url))

const source = process.argv[2]
if (source === undefined || !existsSync(source)) {
  console.error('usage: node tests/make-fixture.mjs <path to session.v4.jsonl.zstd>')
  process.exit(1)
}

/** Collect the byte offset of every zstd frame in the log. */
function frames(buf) {
  const offsets = []
  let pos = 0
  let guard = 0
  while (pos < buf.length && guard < 400000) {
    guard += 1
    let decoded
    try { decoded = zstdDecompressSync(buf.subarray(pos)) } catch { break }
    if (decoded.length === 0) break
    if (decoded.toString('utf8')[0] !== '{') break
    offsets.push(pos)
    let next = -1
    let probe = buf.indexOf(MAGIC, pos + 4)
    while (probe >= 0) {
      try {
        const candidate = zstdDecompressSync(buf.subarray(probe))
        if (candidate.length > 0 && candidate.toString('utf8')[0] === '{') { next = probe; break }
      } catch {}
      probe = buf.indexOf(MAGIC, probe + 1)
    }
    if (next < 0) break
    pos = next
  }
  return offsets
}

const buf = readFileSync(source)
const offsets = frames(buf)
if (offsets.length < 100) {
  console.error('only ' + offsets.length + ' frames decoded; is this a session log?')
  process.exit(1)
}

// Keep the head (header, early history) and the tail (the failure storm). Two
// contiguous byte ranges only — splicing individual frames would produce a log that
// does not decode.
const headEnd = offsets[Math.min(400, offsets.length - 1)]
const tailStart = offsets[Math.max(0, offsets.length - 2000)]
const trimmed = Buffer.concat([buf.subarray(0, headEnd), buf.subarray(tailStart)])

const dir = join(here, 'fixtures')
mkdirSync(dir, { recursive: true })
writeFileSync(join(dir, 'trimmed-poisoned-session.v4.jsonl.zstd'), trimmed)

// Extract the compaction outcome sequence: codes only, no conversation text, which is
// why this file IS safe to commit.
const sequence = []
for (const offset of offsets) {
  let decoded
  try { decoded = zstdDecompressSync(buf.subarray(offset)) } catch { continue }
  const text = decoded.toString('utf8')
  if (text[0] !== '{') continue
  for (const line of text.split('\n')) {
    if (line.length === 0 || line[0] !== '{' || !line.includes('compaction/end')) continue
    try {
      const event = JSON.parse(line)
      const code = event.data?.error === undefined
        ? undefined
        : (String(event.data.error).match(/"code":"([^"]+)"/)?.[1] ?? 'other')
      sequence.push({ ok: event.data?.error === undefined, code, time: event.time })
    } catch {}
  }
}

writeFileSync(join(dir, 'compaction-sequence.json'), JSON.stringify(sequence))
const failures = sequence.filter((row) => !row.ok).length
console.log('trimmed session: ' + (trimmed.length / 1048576).toFixed(2) + 'MB from ' + (buf.length / 1048576).toFixed(2) + 'MB')
console.log('compaction outcomes: ' + sequence.length + ' (' + failures + ' failures)')
