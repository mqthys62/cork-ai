#!/usr/bin/env node
/**
 * Recompute every published figure from the raw runs in raw/.
 *
 * The point of this file is that you do not have to believe the numbers in
 * README.md or docs/AB-TESTING.md. Run it and it prints them again from the
 * measurements, with the statistics done in front of you:
 *
 *   node docs/evidence/verify.mjs
 *
 * If a number here disagrees with a number in the docs, the docs are wrong.
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const read = f => fs.readFileSync(path.join(HERE, 'raw', f), 'utf-8')
  .trim().split('\n').filter(Boolean).map(l => JSON.parse(l))

const median = a => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 }

/** Paired Wilcoxon signed-rank, normal approximation with tie correction. */
function wilcoxon(diffs) {
  const nz = diffs.filter(d => d !== 0)
  const n = nz.length
  if (n < 6) return { n, p: null }
  const sorted = nz.map(d => ({ d, a: Math.abs(d) })).sort((x, y) => x.a - y.a)
  let i = 0
  while (i < sorted.length) {
    let j = i
    while (j + 1 < sorted.length && sorted[j + 1].a === sorted[i].a) j++
    const avg = (i + j + 2) / 2
    for (let k = i; k <= j; k++) sorted[k].rank = avg
    i = j + 1
  }
  const W = sorted.filter(s => s.d > 0).reduce((s, x) => s + x.rank, 0)
  const mean = n * (n + 1) / 4
  const sd = Math.sqrt(n * (n + 1) * (2 * n + 1) / 24)
  const z = (W - mean - Math.sign(W - mean) * 0.5) / sd
  const erf = x => {
    const t = 1 / (1 + 0.3275911 * x)
    return 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x)
  }
  return { n, p: 2 * (1 - 0.5 * (1 + erf(Math.abs(z) / Math.SQRT2))) }
}

function pairsOf(rows) {
  const key = r => `${r.task}#${r.rep}`
  const out = []
  for (const t of rows.filter(r => r.arm === 'treatment' && r.ok && r.costUSD)) {
    const c = rows.find(x => x.arm === 'control' && x.ok && x.costUSD && key(x) === key(t))
    if (c) out.push({ t, c })
  }
  return out
}

function metric(label, pairs, get) {
  const ratios = pairs.map(p => get(p.t) / get(p.c)).filter(r => Number.isFinite(r) && r > 0)
  if (!ratios.length) { console.log(`  ${label.padEnd(13)} not recorded`); return }
  const logs = ratios.map(Math.log)
  const { n, p } = wilcoxon(logs)
  const pct = (Math.exp(median(logs)) - 1) * 100
  const sig = p === null ? 'n too small' : p < 0.05 ? `p=${p.toFixed(3)} SIGNIFICANT` : `p=${p.toFixed(3)} not significant`
  console.log(`  ${label.padEnd(13)} ${(pct >= 0 ? '+' : '') + pct.toFixed(1)}%`.padEnd(30) + `n=${n}  ${sig}`)
}

console.log('\n=== A/B on a real repository (2026-09-15) ===\n')
const repo = read('ab-repo-2026-09-15.jsonl')
const pairs = pairsOf(repo)
console.log(`${repo.length} runs, ${pairs.length} complete pairs, ${new Set(pairs.map(p => p.t.task)).size} tasks`)
console.log(`Total cost: $${repo.reduce((s, r) => s + (r.costUSD ?? 0), 0).toFixed(2)} list-price equivalent`)
console.log(`Wall clock: ${(repo.reduce((s, r) => s + r.wallMs, 0) / 3600000).toFixed(1)}h\n`)
console.log('Treatment vs control (negative = cork-ai costs less):')
metric('cost', pairs, r => r.costUSD)
metric('turns', pairs, r => r.turns)
metric('cache read', pairs, r => r.usage?.cache_read_input_tokens)
metric('cache write', pairs, r => r.usage?.cache_creation_input_tokens)
metric('output', pairs, r => r.usage?.output_tokens)

const acted = pairs.filter(p => p.t.compressions > 0)
const inert = pairs.filter(p => p.t.compressions === 0)
const costRatio = ps => ps.length ? ((Math.exp(median(ps.map(p => Math.log(p.t.costUSD / p.c.costUSD)))) - 1) * 100).toFixed(1) : '—'
console.log(`\nSplit by whether cork-ai acted:`)
console.log(`  compressed something  n=${acted.length}  median cost ${costRatio(acted)}%`)
console.log(`  inert (0 compression) n=${inert.length}  median cost ${costRatio(inert)}%`)

const sum = (rows, f) => rows.reduce((s, r) => s + (f(r) ?? 0), 0)
console.log(`\nWhat cork-ai did across all ${repo.length} runs:`)
console.log(`  compressions ${sum(repo, r => r.compressions)}`)
console.log(`  tokens kept out of context ${sum(repo, r => r.savedTokens).toLocaleString()}`)
console.log(`  targeted range reads ${sum(repo, r => r.rangeReads)}`)
console.log(`  full re-reads ${sum(repo, r => r.reReads)}   <- the rtk failure mode`)

const ansT = median(repo.filter(r => r.arm === 'treatment').map(r => r.answerBytes / 1024))
const ansC = median(repo.filter(r => r.arm === 'control').map(r => r.answerBytes / 1024))
console.log(`\n  answer size: ${ansT.toFixed(1)}KB treatment vs ${ansC.toFixed(1)}KB control`)
console.log(`  (rules out saving by producing less; says nothing about correctness)`)

console.log('\n=== SkillsBench probe (2026-09-14) ===\n')
const probe = read('skillsbench-probe-2026-09-14.jsonl')
console.log(`${probe.length} tasks probed on the treatment arm, $${sum(probe, r => r.costUSD).toFixed(2)}`)
console.log(`Compressions in total: ${sum(probe, r => r.compressions)}`)
for (const r of probe) console.log(`  ${r.task.padEnd(30)} ${r.compressions} compressed  ${r.ok ? '' : '(timed out)'}`)
console.log(`\nWhy this benchmark was set aside: its tasks are solved through Bash,`)
console.log(`so the Read path cork-ai exists for is never exercised.\n`)
