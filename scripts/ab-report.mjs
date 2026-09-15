#!/usr/bin/env node
/**
 * Reads results.jsonl and answers one question: does cork-ai change the bill?
 *
 * Paired Wilcoxon signed-rank on per-task log cost ratios. Paired because both
 * arms ran the same task, log because cost is multiplicative and skewed, and
 * a rank test because ten tasks is far too few to assume normality. The
 * headline is the median ratio, which is what JetBrains reported (+7.6%).
 *
 * A cost result is only meaningful if both arms solved the task equally often,
 * so success is reported alongside and never averaged into the cost figure.
 */
import fs from 'fs'

const file = process.argv[2] ?? 'ab-results/results.jsonl'
const rows = fs.readFileSync(file, 'utf-8').trim().split('\n').map(l => JSON.parse(l))

const key = r => `${r.task}#${r.rep}`
const pairs = []
for (const r of rows.filter(r => r.arm === 'treatment')) {
  const c = rows.find(x => x.arm === 'control' && key(x) === key(r))
  if (!c) continue
  // A crashed run has no cost to compare; excluding it is honest, counting it
  // as zero would be a free win for whichever arm crashed.
  if (!r.ok || !c.ok || !r.costUSD || !c.costUSD) continue
  pairs.push({ task: r.task, rep: r.rep, t: r, c })
}

if (pairs.length === 0) { console.log('No comparable pairs.'); process.exit(0) }

/** Exact-ish Wilcoxon signed-rank; normal approximation with tie correction. */
function wilcoxon(diffs) {
  const nz = diffs.filter(d => d !== 0)
  const n = nz.length
  if (n < 6) return { n, p: null }
  const sorted = nz.map(d => ({ d, a: Math.abs(d) })).sort((x, y) => x.a - y.a)
  // Average ranks within ties, or tied magnitudes would bias the statistic.
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
  const p = 2 * (1 - 0.5 * (1 + erf(Math.abs(z) / Math.SQRT2)))
  return { n, W, z, p }
}
function erf(x) {
  const t = 1 / (1 + 0.3275911 * x)
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x)
  return y
}
const C_NA = 'not recorded in these runs'
const median = a => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 }

const metric = (name, get) => {
  const ratios = pairs.map(p => get(p.t) / get(p.c)).filter(r => Number.isFinite(r) && r > 0)
  if (!ratios.length) return
  const logs = ratios.map(Math.log)
  const { n, p } = wilcoxon(logs)
  // All-identical ratios mean the field was absent or constant, not "no effect".
  if (logs.every(l => l === 0)) { console.log(`  ${name.padEnd(14)} ${C_NA}`); return }
  const med = Math.exp(median(logs))
  const pct = (med - 1) * 100
  const dir = pct > 0 ? 'MORE' : 'less'
  const sig = p === null ? 'n too small for a p-value' : p < 0.05 ? `p=${p.toFixed(4)} significant` : `p=${p.toFixed(3)} not significant`
  console.log(`  ${name.padEnd(14)} ${(pct >= 0 ? '+' : '') + pct.toFixed(1)}% ${dir.padEnd(5)} with cork-ai   median ratio ${med.toFixed(3)}   n=${n}   ${sig}`)
}

console.log(`\nA/B — cork-ai vs no cork-ai   (${pairs.length} paired runs, ${new Set(pairs.map(p => p.task)).size} tasks)\n`)
console.log('Cost and tokens: treatment relative to control. Positive = cork-ai costs more.')
metric('cost', r => r.costUSD)
metric('turns', r => r.turns)
metric('cache read', r => r.usage?.cache_read_input_tokens)
metric('cache write', r => r.usage?.cache_creation_input_tokens)
metric('output', r => r.usage?.output_tokens)

// A pair where cork-ai compressed nothing measures how two agent sessions
// happened to differ, not what this tool does. Say so before any cost figure
// is read as a verdict.
const inert = pairs.filter(p => (p.t.compressions ?? 0) === 0).length
if (inert) {
  console.log(`\n  ! ${inert} of ${pairs.length} pair(s) had ZERO compressions in the treatment arm.`)
  console.log(`  ! cork-ai never acted there, so those pairs measure agent variance, not this tool.`)
  if (inert === pairs.length) console.log(`  ! That is every pair: this run says nothing about cork-ai.`)
}

// The read-heavy tasks are where cork-ai is expected to win; the adverse ones
// are ordinary work where the hook still runs on every call and has little to
// compress. A single pooled average hides both, and the adverse half is the
// one that decides whether this tool is worth installing for someone whose
// work does not look like the flattering half. rtk was +7.6% overall for
// exactly this reason: a permanent cost against an occasional gain.
const profiles = [...new Set(pairs.map(p => p.t.profile).filter(Boolean))]
if (profiles.length > 1) {
  console.log(`\nBy workload profile — the adverse half is the one that decides this:`)
  for (const prof of profiles.sort()) {
    const sub = pairs.filter(p => p.t.profile === prof)
    const ratios = sub.map(p => p.t.costUSD / p.c.costUSD).filter(Number.isFinite)
    if (!ratios.length) continue
    const med = median(ratios)
    const { p: pv } = wilcoxon(ratios.map(Math.log))
    const pct = (med - 1) * 100
    const sig = pv === null ? 'n too small' : pv < 0.05 ? `p=${pv.toFixed(4)} significant` : `p=${pv.toFixed(3)} not significant`
    const comp = sub.reduce((a, b) => a + (b.t.compressions ?? 0), 0)
    console.log(`  ${prof.padEnd(12)} cost ${(pct >= 0 ? '+' : '') + pct.toFixed(1)}%   n=${sub.length}   ${comp} compression(s)   ${sig}`)
  }
  const adv = pairs.filter(p => p.t.profile === 'adverse')
  if (adv.length) {
    const advMed = median(adv.map(p => p.t.costUSD / p.c.costUSD).filter(Number.isFinite))
    console.log(advMed > 1.05
      ? `  ! cork-ai costs MORE on ordinary work. That is the rtk failure mode; the overall figure is not the whole story.`
      : `  Ordinary work is not penalised, so the saving on read-heavy work is not bought from elsewhere.`)
  }
}

const solved = arm => rows.filter(r => r.arm === arm && r.reward === 1).length
const attempted = arm => rows.filter(r => r.arm === arm && r.reward !== null).length
console.log(`\nTask success (a tool that saves tokens by failing has saved nothing):`)
console.log(`  treatment ${solved('treatment')}/${attempted('treatment')}     control ${solved('control')}/${attempted('control')}`)

const crashed = rows.filter(r => !r.ok).length
if (crashed) console.log(`\n  ${crashed} run(s) crashed and were excluded from the cost comparison.`)
console.log()
