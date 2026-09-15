#!/usr/bin/env node
/**
 * Does cork-ai make the answers worse?
 *
 * Cost is only half the question. A tool that cuts the bill by feeding the
 * model less of the file could easily be buying that saving with worse
 * answers, and the A/B harness cannot see it: `answerBytes` measures length,
 * and a confidently wrong answer is exactly as long as a correct one.
 *
 * So every pair is graded blind. For one task and one repeat, the two answers
 * are shown to a fresh judge as "A" and "B", in a random order the judge
 * cannot infer, with no mention of cork-ai, compression, or that a tool is
 * under test. The judge reads the repository itself to check the claims, and
 * returns a verdict plus a factual-error count for each answer.
 *
 * The order is recorded so the verdict can be un-blinded afterwards, and the
 * seed is stored so the whole grading is reproducible.
 *
 * Judging is itself paid work: one judge call per pair, on a full repository.
 * Budget for it as roughly one extra arm.
 */
import { spawnSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

const OUT = process.argv[2] ?? 'ab-repo-results'
const TIMEOUT_MS = Number(process.env.AB_TIMEOUT_MS ?? 900_000)
const DRY = process.argv.includes('--dry-run')
/**
 * The judge runs on the strongest model available, regardless of what the
 * graded answers ran on. Grading is harder than answering: it means reading
 * both answers AND verifying every claim against the source. A weak judge
 * that cannot tell a correct claim from a plausible one would report "tie"
 * on everything and quietly hide a real quality regression.
 */
const JUDGE_MODEL = process.env.AB_JUDGE_MODEL ?? 'opus'

const REPOS = {
  'cork-ai': '/home/mathys/projects/cork-ai',
  'essenly': '/home/mathys/projects/marie-beauty',
}

/**
 * The judge is told nothing about cork-ai, compression, or that two systems
 * are being compared for cost. It is asked to grade two answers to the same
 * question against the source of truth — the repository — and nothing else.
 */
function judgePrompt(question) {
  return `Two engineers were each asked the same question about this repository and wrote an answer. Your job is to grade both against the code itself.

The question they were asked:
---
${question}
---

Their answers are in ANSWER_A.md and ANSWER_B.md in the current directory.

Read both. Then verify their claims against the actual source in this repository — open the files they cite and check that what they say is true. Do not take either answer's word for anything.

Judge on, in this order of importance:
1. Factual accuracy. A claim that contradicts the code is an error. Count them.
2. Completeness. Did the answer cover what the question actually asked for, or did it skip parts?
3. Specificity. Naming the real function, constant or file beats a vague description of it.

Length is not quality. A shorter answer that is correct and complete is better than a longer one that pads or repeats.

Write your verdict to VERDICT.json in the current directory, in exactly this shape and nothing else:
{
  "a": { "errors": <count of factually wrong claims>, "completeness": <0-10>, "specificity": <0-10> },
  "b": { "errors": <count of factually wrong claims>, "completeness": <0-10>, "specificity": <0-10> },
  "better": "a" | "b" | "tie",
  "why": "<two sentences, citing the decisive difference>"
}`
}

/** Deterministic per-pair coin flip, so a rerun blinds identically. */
function flip(seed, key) {
  let h = 2166136261 >>> 0
  for (const ch of `${seed}:${key}`) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0 }
  return (h & 1) === 1
}

function loadPairs(resultsPath) {
  const rows = fs.readFileSync(resultsPath, 'utf-8').trim().split('\n')
    .filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  const pairs = []
  for (const t of rows.filter(r => r.arm === 'treatment' && r.ok && r.answerPath)) {
    const c = rows.find(r => r.arm === 'control' && r.ok && r.answerPath && r.task === t.task && r.rep === t.rep)
    if (c) pairs.push({ task: t.task, repo: t.repo, rep: t.rep, t, c })
  }
  return pairs
}

function main() {
  const resultsPath = path.join(OUT, 'results.jsonl')
  if (!fs.existsSync(resultsPath)) { console.log(`No results at ${resultsPath}`); return }

  const seed = process.env.AB_JUDGE_SEED ?? 'cork-ai-blind-v1'
  const verdictsPath = path.join(OUT, 'verdicts.jsonl')
  const done = new Set()
  if (fs.existsSync(verdictsPath)) {
    for (const l of fs.readFileSync(verdictsPath, 'utf-8').trim().split('\n').filter(Boolean)) {
      try { done.add(`${JSON.parse(l).task}#${JSON.parse(l).rep}`) } catch { /* skip */ }
    }
  }

  const pairs = loadPairs(resultsPath).filter(p => !done.has(`${p.task}#${p.rep}`))
  console.log(`${pairs.length} pair(s) to grade blind, seed "${seed}".`)
  if (done.size) console.log(`${done.size} already graded.`)
  console.log(`The judge is never told which answer came from which arm.`)
  console.log(`Judge model: ${JUDGE_MODEL}, running without cork-ai.\n`)

  if (DRY) { for (const p of pairs) console.log(`  ${p.task} rep${p.rep}  A=${flip(seed, `${p.task}#${p.rep}`) ? 'control' : 'treatment'}`); return }

  // The questions live in ab-repo.mjs; read them back rather than duplicating.
  const src = fs.readFileSync(new URL('./ab-repo.mjs', import.meta.url), 'utf-8')
  const questions = {}
  for (const m of src.matchAll(/name: '([^']+)',\s*\n\s*repo: '[^']+',\s*\n\s*prompt: `([^`]+)`/g)) questions[m[1]] = m[2]

  for (const p of pairs) {
    const key = `${p.task}#${p.rep}`
    const aIsControl = flip(seed, key)
    const dir = path.join(OUT, 'judge', `${p.task}-${p.rep}`)
    fs.rmSync(dir, { recursive: true, force: true })
    fs.mkdirSync(dir, { recursive: true })

    // The judge works in a copy of the repo, so it can verify claims against
    // the source without any chance of touching the user's files.
    const repo = REPOS[p.repo]
    const r0 = spawnSync('rsync', ['-a', '--exclude', 'node_modules', '--exclude', '.git', '--exclude', 'dist',
      '--exclude', '.next', '--exclude', 'release', '--exclude', 'build', '--exclude', '.venv',
      repo.replace(/\/?$/, '/'), dir], { encoding: 'utf-8', timeout: 300_000 })
    if (r0.status !== 0) { console.log(`  ${key}: copy failed`); continue }

    fs.copyFileSync(path.join(OUT, (aIsControl ? p.c : p.t).answerPath), path.join(dir, 'ANSWER_A.md'))
    fs.copyFileSync(path.join(OUT, (aIsControl ? p.t : p.c).answerPath), path.join(dir, 'ANSWER_B.md'))

    process.stdout.write(`  ${p.task.padEnd(20)} rep${p.rep} `)
    const env = { ...process.env }
    delete env.ANTHROPIC_API_KEY
    delete env.ANTHROPIC_AUTH_TOKEN
    // The judge runs without cork-ai: a compressed read could hide the very
    // detail it needs to catch an error, and the judge must see the truth.
    const judgeHome = path.join(OUT, 'judge-home', key.replace('#', '-'))
    fs.mkdirSync(judgeHome, { recursive: true })
    fs.writeFileSync(path.join(judgeHome, 'settings.json'), '{}')
    const creds = path.join(os.homedir(), '.claude', '.credentials.json')
    if (fs.existsSync(creds)) fs.copyFileSync(creds, path.join(judgeHome, '.credentials.json'))
    env.CLAUDE_CONFIG_DIR = judgeHome

    const started = Date.now()
    const res = spawnSync('claude', ['-p', judgePrompt(questions[p.task] ?? '(question unavailable)'),
      '--output-format', 'json', '--model', JUDGE_MODEL, '--permission-mode', 'bypassPermissions'],
      { cwd: dir, encoding: 'utf-8', timeout: TIMEOUT_MS, env })
    const wallMs = Date.now() - started

    let verdict = null
    try { verdict = JSON.parse(fs.readFileSync(path.join(dir, 'VERDICT.json'), 'utf-8')) } catch { /* judge failed */ }
    let meta = null
    try { meta = JSON.parse(res.stdout) } catch { /* crashed */ }

    if (!verdict) {
      console.log(`no verdict (judge cost $${(meta?.total_cost_usd ?? 0).toFixed(4)})`)
      fs.rmSync(dir, { recursive: true, force: true })
      continue
    }

    // Un-blind only now, after the judge has spoken.
    const treatment = aIsControl ? verdict.b : verdict.a
    const control = aIsControl ? verdict.a : verdict.b
    const better = verdict.better === 'tie' ? 'tie'
      : (verdict.better === 'a') === aIsControl ? 'control' : 'treatment'

    const row = {
      task: p.task, repo: p.repo, rep: p.rep, seed, aIsControl,
      treatment, control, better, why: verdict.why,
      judgeCostUSD: meta?.total_cost_usd ?? null, wallMs,
    }
    fs.appendFileSync(verdictsPath, JSON.stringify(row) + '\n')
    console.log(`${better.padEnd(9)} errors t=${treatment.errors} c=${control.errors}  $${(meta?.total_cost_usd ?? 0).toFixed(4)}  ${Math.round(wallMs/1000)}s`)
    fs.rmSync(dir, { recursive: true, force: true })
  }

  console.log(`\nVerdicts in ${verdictsPath}`)
  console.log(`Summarise with: node scripts/ab-judge.mjs ${OUT} --summary`)
}

function summary() {
  const rows = fs.readFileSync(path.join(OUT, 'verdicts.jsonl'), 'utf-8').trim().split('\n')
    .filter(Boolean).map(l => JSON.parse(l))
  const n = rows.length
  const wins = { treatment: 0, control: 0, tie: 0 }
  for (const r of rows) wins[r.better]++
  const errT = rows.reduce((s, r) => s + r.treatment.errors, 0)
  const errC = rows.reduce((s, r) => s + r.control.errors, 0)
  const avg = (f) => (rows.reduce((s, r) => s + f(r), 0) / n).toFixed(1)

  console.log(`\n  Blind quality grading — ${n} pair(s)\n`)
  console.log(`  Judge preferred   treatment ${wins.treatment}   control ${wins.control}   tie ${wins.tie}`)
  console.log(`  Factual errors    treatment ${errT}   control ${errC}`)
  console.log(`  Completeness      treatment ${avg(r => r.treatment.completeness)}/10   control ${avg(r => r.control.completeness)}/10`)
  console.log(`  Specificity       treatment ${avg(r => r.treatment.specificity)}/10   control ${avg(r => r.control.specificity)}/10`)

  // A sign test on the non-tied pairs: is either arm preferred more than chance?
  const nz = wins.treatment + wins.control
  if (nz >= 6) {
    const k = Math.min(wins.treatment, wins.control)
    let p = 0
    for (let i = 0; i <= k; i++) {
      let c = 1
      for (let j = 0; j < i; j++) c = c * (nz - j) / (j + 1)
      p += c * Math.pow(0.5, nz)
    }
    p = Math.min(1, 2 * p)
    console.log(`\n  Sign test on ${nz} non-tied pair(s): p = ${p.toFixed(3)}`)
    console.log(`  ${p < 0.05 ? '  One arm is genuinely preferred.' : '  No detectable difference in answer quality.'}`)
  } else {
    console.log(`\n  Only ${nz} non-tied pair(s) — too few for a sign test.`)
  }
  const judgeCost = rows.reduce((s, r) => s + (r.judgeCostUSD ?? 0), 0)
  console.log(`\n  Grading cost ${judgeCost.toFixed(2)} USD equivalent.`)
}

if (process.argv.includes('--summary')) summary()
else main()
