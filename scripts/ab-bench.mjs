#!/usr/bin/env node
/**
 * A/B harness — does cork-ai make Claude Code cheaper, or more expensive?
 *
 * JetBrains A/B-tested rtk against a control and found it *increased* median
 * cost by 7.6% while rtk itself reported 99.8% savings. A tool cannot measure
 * its own effect: the counterfactual it computes is a claim about a world it
 * did not run. Only a control arm settles it.
 *
 * Design:
 *   - treatment: real hooks, CORK_AI_HOME pointed at a per-run sandbox.
 *   - control:   CLAUDE_CONFIG_DIR pointed at a clean dir with settings.json={}
 *                and .credentials.json copied. `--settings` MERGES instead of
 *                replacing, so it cannot be used to build a control arm.
 *   - paired:    both arms run the same task from the same pristine copy, so
 *                the comparison is within-task and per-task difficulty cancels.
 *
 * Cost comes from `total_cost_usd`, which the CLI fills under OAuth at list
 * price (costBasis: "list") and which includes subagents — `usage` excludes
 * them. Success comes from SkillsBench's own verifier, run in Docker: a tool
 * that saves tokens by failing the task has not saved anything.
 *
 * Nothing here is billed beyond the subscription the runs already consume.
 */
import { execFileSync, spawnSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

const ROOT = process.env.SKILLSBENCH_DIR
const OUT = process.env.AB_OUT ?? path.join(process.cwd(), 'ab-results')
const REPEATS = Number(process.env.AB_REPEATS ?? 3)
const TIMEOUT_MS = Number(process.env.AB_TIMEOUT_MS ?? 900_000)
const VERIFY_TIMEOUT_MS = Number(process.env.AB_VERIFY_TIMEOUT_MS ?? 300_000)
const DRY = process.argv.includes('--dry-run')
const TASKS = (process.env.AB_TASKS ?? '').split(',').filter(Boolean)

// The tasks whose environment actually exercises the hook: files large enough
// to clear the gate. On the rest cork-ai is inert and the run is pure noise.
const DEFAULT_TASKS = [
  'enterprise-information-search', 'organize-messy-files', 'citation-check',
  'fix-druid-loophole-cve', 'flink-query', 'python-scala-translation',
  'invoice-fraud-detection', 'pdf-excel-diff', 'simpo-code-reproduction',
  'software-dependency-audit',
]
// fix-druid-loophole-cve is left out on purpose: its WORKDIR is ${WORKSPACE},
// a build arg this harness does not reproduce, so the verifier would never
// find the agent's output.

function sh(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf-8', timeout: TIMEOUT_MS, ...opts })
}

/** A clean Claude Code config with no hooks at all: the control arm. */
function makeControlHome(dir) {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'settings.json'), '{}')
  // OAuth only. An ANTHROPIC_API_KEY in the environment would bill separately,
  // so runArm strips it from both arms.
  const creds = path.join(os.homedir(), '.claude', '.credentials.json')
  if (fs.existsSync(creds)) fs.copyFileSync(creds, path.join(dir, '.credentials.json'))
}

/** Consecutive dead runs after which something is wrong with the setup, not the task. */
const MAX_CONSECUTIVE_FAILURES = 3

/**
 * Did this run die because the subscription's window is exhausted?
 *
 * There is no machine-readable signal for it, so this matches the CLI's own
 * wording on a run that produced no JSON at all. It is a hint, not a
 * contract — MAX_CONSECUTIVE_FAILURES is the real backstop.
 */
function looksLikeUsageLimit(r) {
  if (r.costUSD !== null) return false
  return /usage limit|rate limit|quota|too many requests|429/i.test(r.stderr ?? '')
}

function runArm({ arm, task, rep, workdir, prompt }) {
  const home = path.join(OUT, 'homes', `${task}-${arm}-${rep}`)
  fs.rmSync(home, { recursive: true, force: true })
  fs.mkdirSync(home, { recursive: true })

  const env = { ...process.env }
  // Never let a key turn a subscription run into a billed API run.
  delete env.ANTHROPIC_API_KEY
  delete env.ANTHROPIC_AUTH_TOKEN

  if (arm === 'control') {
    makeControlHome(home)
    // settings.json is {}, so Claude Code loads no hooks at all and cork-ai
    // is never invoked. There is no env switch to double up with, and none is
    // needed: the control arm is defined by the absence of the hook.
    env.CLAUDE_CONFIG_DIR = home
  } else {
    // Treatment keeps the user's real settings (the hooks under test) but
    // gives cork-ai a fresh brain, so one run cannot teach the next.
    env.CORK_AI_HOME = home
  }

  const started = Date.now()
  const res = sh('claude', ['-p', prompt, '--output-format', 'json',
    '--permission-mode', 'bypassPermissions'], { cwd: workdir, env })
  const wallMs = Date.now() - started

  let json = null
  try { json = JSON.parse(res.stdout) } catch { /* crashed or timed out */ }
  return {
    arm, task, rep, wallMs,
    ok: !!json && !json.is_error,
    costUSD: json?.total_cost_usd ?? null,
    turns: json?.num_turns ?? json?.usage?.iterations?.length ?? null,
    usage: json?.usage ?? null,
    modelUsage: json?.modelUsage ?? null,
    sessionId: json?.session_id ?? null,
    stderr: res.stdout ? '' : (res.stderr ?? '').slice(-600),
  }
}

/**
 * Where the task expects its files to live. Most tasks use /root, but not all
 * (flink-query uses /app/workspace), and the verifier asserts on absolute
 * paths — mounting to the wrong one fails every run of both arms equally,
 * which looks like a null result instead of a broken harness.
 */
/**
 * Pairs already measured, from a previous session's results.jsonl.
 *
 * A subscription's 5-hour window rarely covers the whole plan, so the
 * benchmark is expected to be stopped and restarted. Only WHOLE pairs count:
 * a half-finished pair is worthless — the arms must run close together for
 * the comparison to hold — so it is simply redone.
 */
function loadCompletePairs(resultsPath) {
  const done = new Set()
  if (!fs.existsSync(resultsPath)) return done
  const prior = fs.readFileSync(resultsPath, 'utf-8').trim().split('\n')
    .filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  for (const r of prior.filter(r => r.ok && r.arm === 'treatment')) {
    if (prior.some(c => c.ok && c.arm === 'control' && c.task === r.task && c.rep === r.rep)) {
      done.add(`${r.task}#${r.rep}`)
    }
  }
  return done
}

function workdirFor(task) {
  const df = path.join(ROOT, 'tasks', task, 'environment', 'Dockerfile')
  const lines = fs.existsSync(df) ? fs.readFileSync(df, 'utf-8').split('\n') : []
  const last = lines.filter(l => /^WORKDIR\s/.test(l)).pop()
  const dir = last?.trim().split(/\s+/)[1]
  // A ${VAR} WORKDIR depends on build args we do not reproduce here.
  return dir && !dir.includes('$') ? dir : '/root'
}

/**
 * Builds the task's own image once and reuses it.
 *
 * Verifiers assume the dependencies their Dockerfile installed, so a generic
 * python image makes each one reinstall its world — minutes per run, and a
 * failure that looks like the agent's fault. Built once per task, before any
 * agent runs, so a build error surfaces as a build error.
 */
const built = new Map()
function imageFor(task) {
  if (built.has(task)) return built.get(task)
  const tag = `cork-ab/${task}:latest`
  const env = path.join(ROOT, 'tasks', task, 'environment')
  const r = sh('docker', ['build', '-q', '-t', tag, env], { timeout: 1_800_000 })
  const ok = r.status === 0
  if (!ok) console.log(`    ! image build failed for ${task}: ${(r.stderr ?? '').slice(-300)}`)
  built.set(task, ok ? tag : null)
  return built.get(task)
}

/** SkillsBench's own verifier, in Docker, with the agent's files mounted in place. */
function verify(task, workdir) {
  const image = imageFor(task)
  if (!image) return { reward: null, verifierRan: false }
  const taskDir = path.join(ROOT, 'tasks', task)
  const logs = path.join(workdir, '.ab-logs')
  fs.mkdirSync(logs, { recursive: true })
  // Network stays on: some verifiers resolve citations or fetch packages.
  // Its own timeout, well under the agent's: on the task image a verifier runs
  // in seconds, so minutes means it is stuck, and a stuck verifier would hold
  // up the whole benchmark.
  const r = sh('docker', ['run', '--rm',
    '-v', `${workdir}:${workdirFor(task)}`,
    '-v', `${path.join(taskDir, 'verifier')}:/verifier:ro`,
    '-v', `${logs}:/logs`,
    image, 'bash', '/verifier/test.sh'], { timeout: VERIFY_TIMEOUT_MS })
  const rewardFile = path.join(logs, 'verifier', 'reward.txt')
  // No reward file means the verifier could not judge, which is not the same
  // as judging the work wrong: null is excluded from the success count, 0 is
  // counted as a failure.
  const reward = fs.existsSync(rewardFile) ? Number(fs.readFileSync(rewardFile, 'utf-8').trim()) : null
  return { reward, verifierRan: r.status === 0 }
}

function main() {
  if (!ROOT || !fs.existsSync(ROOT)) {
    console.error('Set SKILLSBENCH_DIR to a checkout of github.com/benchflow-ai/skillsbench')
    process.exit(1)
  }
  const tasks = (TASKS.length ? TASKS : DEFAULT_TASKS)
    .filter(t => fs.existsSync(path.join(ROOT, 'tasks', t)))
  fs.mkdirSync(OUT, { recursive: true })

  const resultsPath = path.join(OUT, 'results.jsonl')
  const done = loadCompletePairs(resultsPath)
  const remaining = tasks.length * REPEATS - done.size
  console.log(`${tasks.length} tasks x ${REPEATS} repeats x 2 arms = ${tasks.length * REPEATS * 2} runs`)
  if (done.size) console.log(`${done.size} pair(s) already done; ${remaining * 2} run(s) left to do.`)
  console.log(`Order is interleaved per task so drift hits both arms equally.`)
  if (DRY) {
    console.log('\n--dry-run: no agent is launched, nothing is consumed.\n')
    for (const t of tasks) {
      const envDir = path.join(ROOT, 'tasks', t, 'environment')
      const files = fs.existsSync(envDir) ? fs.readdirSync(envDir).length : 0
      console.log(`  ${t.padEnd(34)} ${String(files).padStart(3)} files  task.md ${fs.existsSync(path.join(ROOT, 'tasks', t, 'task.md')) ? 'ok' : 'MISSING'}`)
    }
    if (remaining === 0) console.log('\nEverything in this plan is already done.')
    console.log('\nEach task image is built once on the first real run (several minutes).')
    console.log('Remove --dry-run to execute.')
    return
  }

  const results = []
  // Stop rather than burn the rest of the plan on runs that cannot succeed.
  let consecutiveFailures = 0
  for (const task of tasks) {
    const taskDir = path.join(ROOT, 'tasks', task)
    const prompt = fs.readFileSync(path.join(taskDir, 'task.md'), 'utf-8')
      .replace(/^---[\s\S]*?\n---\n/, '').trim()
    for (let rep = 0; rep < REPEATS; rep++) {
      if (done.has(`${task}#${rep}`)) continue
      // Interleave: a slow API hour must not land on one arm only.
      for (const arm of (rep % 2 === 0 ? ['treatment', 'control'] : ['control', 'treatment'])) {
        const workdir = path.join(OUT, 'work', `${task}-${arm}-${rep}`)
        fs.rmSync(workdir, { recursive: true, force: true })
        fs.mkdirSync(path.dirname(workdir), { recursive: true })
        fs.cpSync(path.join(taskDir, 'environment'), workdir, { recursive: true })

        process.stdout.write(`  ${task} rep${rep} ${arm.padEnd(9)} `)
        const r = runArm({ arm, task, rep, workdir, prompt })
        const v = verify(task, workdir)
        Object.assign(r, v)
        results.push(r)
        fs.appendFileSync(resultsPath, JSON.stringify(r) + '\n')
        console.log(`${r.ok ? '' : 'FAILED '}$${(r.costUSD ?? 0).toFixed(4)}  ${r.turns ?? '?'} turns  reward=${r.reward ?? '?'}  ${Math.round(r.wallMs / 1000)}s`)

        if (r.ok) { consecutiveFailures = 0; continue }
        consecutiveFailures++
        // A run that produced no JSON at all and said so is the usage limit:
        // continuing would spend the remaining plan on runs that cannot work,
        // and leave half-pairs behind. Stopping keeps the file resumable.
        if (looksLikeUsageLimit(r) || consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          console.log(`\n  Stopping: ${looksLikeUsageLimit(r) ? 'usage limit reached' : `${consecutiveFailures} runs failed in a row`}.`)
          console.log(`  ${results.filter(x => x.ok).length} good run(s) saved. Re-run the same command later to resume.`)
          return finish(results, resultsPath)
        }
      }
    }
  }
  return finish(results, resultsPath)
}

function finish(results, resultsPath) {
  console.log(`\n${results.length} run(s) this session, appended to ${resultsPath}`)
  console.log(`Analyse with: node scripts/ab-report.mjs ${resultsPath}`)
}

main()
