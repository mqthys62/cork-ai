#!/usr/bin/env node
/**
 * Does the report tell the truth when the truth is bad?
 *
 * The A/B harness reported that cork-ai costs 14.8% less. That number is only
 * worth something if the same harness would have reported a loss had there
 * been one. So: plant a known regression in synthetic data, and check it is
 * reported as a regression, significant, at roughly the planted size.
 *
 * This is the cheapest test in the project — it spends nothing — and it is the
 * one that makes the expensive measurement believable. Run it before trusting
 * any campaign result.
 */
import { spawnSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

/** A deterministic LCG, so a failure is reproducible. */
function rng(seed) {
  return () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
}

/** 12 synthetic pairs where treatment costs `effect` times control. */
function synth(effect, seed = 42) {
  const rnd = rng(seed)
  const rows = []
  for (let i = 0; i < 12; i++) {
    const base = 3 + rnd() * 2
    const noise = 0.9 + rnd() * 0.2
    rows.push({ arm: 'control', task: `t${i}`, repo: 'x', rep: 0, ok: true, costUSD: base,
      turns: 20, answerBytes: 20000, usage: { cache_read_input_tokens: 600_000 } })
    rows.push({ arm: 'treatment', task: `t${i}`, repo: 'x', rep: 0, ok: true,
      costUSD: base * effect * noise, turns: 20, answerBytes: 20000,
      compressions: 3, reReads: 0, usage: { cache_read_input_tokens: 600_000 } })
  }
  return rows.map(r => JSON.stringify(r)).join('\n')
}

function report(rows) {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ab-self-')), 'r.jsonl')
  fs.writeFileSync(f, rows)
  const out = spawnSync('node', [path.join(import.meta.dirname, 'ab-report.mjs'), f],
    { encoding: 'utf-8' }).stdout ?? ''
  fs.rmSync(path.dirname(f), { recursive: true, force: true })
  return out
}

const cases = [
  { name: 'a planted +25% regression is reported as a significant regression',
    effect: 1.25,
    check: o => /cost\s+\+2\d\.\d% MORE/.test(o) && /cost.*[^t] significant/.test(o) },
  { name: 'a planted -25% saving is reported as a significant saving',
    effect: 0.75,
    check: o => /cost\s+-2\d\.\d% less/i.test(o) && /cost.*[^t] significant/.test(o) },
  { name: 'no real difference is NOT reported as significant',
    effect: 1.0,
    check: o => /cost.*not significant/.test(o) },
]

let failed = 0
console.log('\n  Harness self-test — can the report see a result it would not like?\n')
for (const c of cases) {
  const out = report(synth(c.effect))
  const ok = c.check(out)
  if (!ok) failed++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${c.name}`)
  if (!ok) console.log(out.split('\n').filter(l => /cost/.test(l)).map(l => `        ${l}`).join('\n'))
}
console.log(failed
  ? `\n  ${failed} check(s) failed — do not trust a campaign result from this report.\n`
  : `\n  The report detects regressions, detects savings, and stays quiet on noise.\n`)
process.exit(failed ? 1 : 0)
