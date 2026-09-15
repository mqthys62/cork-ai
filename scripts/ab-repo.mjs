#!/usr/bin/env node
/**
 * A/B on real repositories — where cork-ai actually acts.
 *
 * SkillsBench turned out to be the wrong instrument: probing eight of its
 * tasks produced not one `Read` call across 110 tool uses, because they are
 * data-processing work done through `Bash`. In real use `Read` is 99.5% of
 * cork-ai's savings, so that benchmark measures the tool almost exactly where
 * it does not operate.
 *
 * These tasks are questions about a real codebase that cannot be answered
 * without reading source files — the work `Read` exists for.
 *
 * They deliberately name NO file. cork-ai refuses to compress a file the user
 * just mentioned (`user-mentioned`, hook.ts) — a sound guard, since a file
 * named in the prompt is one the model was asked to look at in full. A first
 * pilot cited paths like `src/cli/policy.ts`, tripped that guard on every
 * read, recorded zero compressions, and would have been reported as "cork-ai
 * had no effect". Naming a file in a benchmark prompt silently disables the
 * thing being measured.
 *
 * SAFETY: the user's repositories are never touched. Each run gets its own
 * copy under the output directory, the agent is confined to that copy, and
 * the originals are fingerprinted before and after so any modification would
 * be caught and reported. Nothing is ever written back.
 */
import { execFileSync, spawnSync } from 'child_process'
import { startTicker, stopTicker, etaFor } from './ab-progress.mjs'
import fs from 'fs'
import os from 'os'
import path from 'path'

const OUT = process.env.AB_OUT ?? path.join(process.cwd(), 'ab-repo-results')
const REPEATS = Number(process.env.AB_REPEATS ?? 3)
const TIMEOUT_MS = Number(process.env.AB_TIMEOUT_MS ?? 900_000)
const DRY = process.argv.includes('--dry-run')
/**
 * The model both arms run. cork-ai's saving is denominated in tokens, but the
 * bill is tokens times a per-model price, so the arms must agree on the model
 * or the comparison measures the price difference instead. Opus is the
 * default here because it is what this tool is used with in practice and it
 * is where a token saved is worth the most.
 *
 * The context window is part of the model identity, not a detail: `opus` and
 * `opus[1m]` are priced differently, so pinning the bare alias would quietly
 * measure a different model than the one in daily use. A stray run during
 * development did exactly that, and it was caught only because `modelUsage`
 * is recorded per run -- which is the reason to record it.
 */
const MODEL = process.env.AB_MODEL ?? 'opus[1m]'
const ONLY = (process.env.AB_TASKS ?? '').split(',').filter(Boolean)

/**
 * Read-heavy questions about real codebases.
 *
 * Every one requires opening several source files to answer: no task can be
 * satisfied by `ls`, a single `grep`, or the README. They are questions, not
 * edits — the agent has no reason to modify anything, and its copy is thrown
 * away regardless.
 *
 * Two repositories, deliberately: a small single-purpose CLI (cork-ai, ~6k
 * lines of TypeScript) and a large NestJS + Angular monorepo (essenly, ~50k
 * files). A result measured on one codebase is a fact about that codebase.
 * cork-ai's decision depends on file size, extension and re-read rate, all of
 * which differ sharply between the two, so a saving that holds on both is
 * evidence about the tool rather than about one repository's shape.
 */
const TASKS = [
  {
    name: 'explain-gate',
    repo: 'cork-ai',
    prompt: `Explore this repository and explain precisely how it decides whether to compress a file read. Cover: the expected-value formula and each of its terms, every condition that refuses compression before the expected value is even considered, how the per-extension re-read probability is learned and what the prior is for an extension never seen before, and how probation and probes work. Write your answer to ANSWER.md in the repository root. Be specific: name the constants and their values.`,
  },
  {
    name: 'trace-hook',
    repo: 'cork-ai',
    prompt: `Explore this repository and trace what happens end to end when the editor asks to read a large source file and this tool intercepts it. Follow the actual code path from the entry point to the decision and the response, naming each function in order and what it computes. Include how the counterfactual token count is derived, how the model and its prices are resolved, and where the result is persisted. Write your answer to ANSWER.md in the repository root.`,
  },
  {
    name: 'audit-accounting',
    repo: 'cork-ai',
    prompt: `Explore this repository and audit how savings are accounted. Identify every place a cost or a saving is computed or stored, explain how the stored lifetime figure relates to what the reporting command displays, list each penalty that is deducted and where it comes from, and point out any place where two code paths could disagree about the same number. Write your findings to ANSWER.md in the repository root, citing file and line for each claim.`,
  },
  {
    name: 'explain-outline',
    repo: 'cork-ai',
    prompt: `Explore this repository and explain how a compressed summary is produced from a source file. Cover which file kinds are recognised and how, the patterns that detect top-level structure and what each is meant to match, how the preview head is chosen, how entries are rendered and truncated, and what makes a summary get rejected as too sparse. Write your answer to ANSWER.md in the repository root, naming the constants and their values.`,
  },
  // --- Tasks where cork-ai has little or nothing to gain. ---
  //
  // The four above are read-heavy by construction: they are where this tool
  // wins, and measuring only them would answer "is cork-ai good at what it is
  // good at". The bill an actual user pays is dominated by work like the
  // tasks below, where the hook still runs on every Read and every Bash and
  // still costs its overhead, but finds little worth compressing.
  //
  // This is exactly how rtk ended up +7.6% more expensive while reporting a
  // 99.8% saving: a permanent per-call cost against an occasional gain. If
  // cork-ai is a net loss on ordinary work, it has to show up here.
  {
    name: 'small-files-edit',
    profile: 'adverse',
    repo: 'cork-ai',
    prompt: `Work through the test suite in this repository and report on its coverage. For each area of behaviour the project implements, say whether tests exist for it, and name three specific behaviours that are currently untested and would be worth covering. Do not write any code; write your findings to ANSWER.md in the repository root.`,
  },
  {
    name: 'shell-heavy',
    profile: 'adverse',
    repo: 'cork-ai',
    prompt: `Using shell commands rather than reading source files, characterise this repository: how many files of each language, the largest directories by size, the commit frequency over the project's life, which files change most often together, and the dependency count. Write the numbers and the commands that produced them to ANSWER.md in the repository root.`,
  },
  {
    name: 'config-question',
    profile: 'adverse',
    repo: 'essenly',
    prompt: `Determine how this project is built, configured and deployed. Cover the package scripts and what each does, the environment variables the application expects and where they are consumed, the container setup, and the database migration mechanism. Write your answer to ANSWER.md in the repository root.`,
  },
  {
    name: 'explain-booking',
    repo: 'essenly',
    prompt: `Explore this repository and explain how an appointment booking is validated and persisted on the server side. Follow the request from the controller that accepts it through to the database write, naming each class and method in order. Cover which fields are validated and how, how conflicting or overlapping bookings are detected, what happens inside a transaction and what does not, and every side effect that is triggered once a booking succeeds. Write your answer to ANSWER.md in the repository root, citing file and line for each claim.`,
  },
  {
    name: 'map-auth',
    repo: 'essenly',
    prompt: `Explore this repository and map its authentication and authorization end to end. Cover how a credential is verified and what is stored, how a session or token is issued, refreshed and revoked, every guard or decorator that protects a route and what each one checks, how roles or permissions are represented, and where the client keeps its credential and attaches it to requests. Write your answer to ANSWER.md in the repository root, naming the classes and the files they live in.`,
  },
  {
    name: 'trace-payment',
    repo: 'essenly',
    prompt: `Explore this repository and trace how a payment or a cash-register transaction is recorded. Identify the entities involved and their relationships, follow the code from the endpoint that receives the operation to the rows it writes, explain how totals and any tax or discount are computed and where rounding happens, and describe what is done to keep the ledger consistent if a step fails partway. Write your answer to ANSWER.md in the repository root, citing file and line.`,
  },
  {
    name: 'audit-frontend-state',
    repo: 'essenly',
    prompt: `Explore the client application in this repository and explain how it manages state and talks to the server. Cover the pattern used to hold shared state and where it lives, how a view obtains data and what happens while it is loading or when it fails, how server errors surface to the user, and every place a call is retried, cached or de-duplicated. Name the services and components involved. Write your answer to ANSWER.md in the repository root.`,
  },
]

function sh(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf-8', timeout: TIMEOUT_MS, ...opts })
}

/** A content fingerprint of the user's repo, to prove it was never modified. */
function fingerprint(repoPath) {
  try {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoPath, encoding: 'utf-8' }).trim()
    const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: repoPath, encoding: 'utf-8' })
    return { head, dirtyCount: dirty.split('\n').filter(Boolean).length, dirty }
  } catch { return null }
}

/**
 * A copy of the repo the agent may do anything to.
 *
 * node_modules and .git are excluded: they dominate the size, and a copy
 * without them still has every source file the questions are about.
 */
function copyRepo(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  // Build output and caches are excluded, not just for size: a 160MB release/
  // directory copied 24 times fills a disk and slows every run, and none of it
  // is source the questions are about.
  const excludes = ['node_modules', '.git', 'dist', '.next', 'vendor', 'release',
    'coverage', '.turbo', 'build', '.venv', '__pycache__', '.pytest_cache']
  const r = sh('rsync', ['-a', ...excludes.flatMap(e => ['--exclude', e]),
    src.replace(/\/?$/, '/'), dest], { timeout: 300_000 })
  if (r.status !== 0) throw new Error(`copy failed: ${r.stderr?.slice(0, 300)}`)
}

function makeControlHome(dir) {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'settings.json'), '{}')
  const creds = path.join(os.homedir(), '.claude', '.credentials.json')
  if (fs.existsSync(creds)) fs.copyFileSync(creds, path.join(dir, '.credentials.json'))
}

function corkActivity(home) {
  let compressions = 0, savedTokens = 0, reReads = 0, rangeReads = 0
  try {
    for (const f of fs.readdirSync(path.join(home, 'digests'))) {
      const d = JSON.parse(fs.readFileSync(path.join(home, 'digests', f), 'utf-8'))
      compressions += d.compressions ?? 0
      savedTokens += d.savedTokens ?? 0
      reReads += d.reReads ?? 0
    }
  } catch { /* nothing ran */ }
  try {
    const pol = JSON.parse(fs.readFileSync(path.join(home, 'policy.json'), 'utf-8'))
    for (const e of Object.values(pol.ext ?? {})) rangeReads += e.rangeReads ?? 0
  } catch { /* none */ }
  return { compressions, savedTokens, reReads, rangeReads }
}

function runArm({ arm, task, rep, workdir }) {
  const home = path.join(OUT, 'homes', `${task.name}-${arm}-${rep}`)
  fs.rmSync(home, { recursive: true, force: true })
  fs.mkdirSync(home, { recursive: true })

  const env = { ...process.env }
  delete env.ANTHROPIC_API_KEY
  delete env.ANTHROPIC_AUTH_TOKEN

  if (arm === 'control') {
    makeControlHome(home)
    env.CLAUDE_CONFIG_DIR = home
  } else {
    env.CORK_AI_HOME = home
  }

  // Pin the model explicitly in BOTH arms. The control runs with an empty
  // settings.json, so it never sees the user's configured model and would
  // fall back to the CLI default; the treatment keeps the real config and
  // would use the configured one. Those happen to agree today, but relying
  // on that is how an A/B silently becomes a comparison of two models.
  const started = Date.now()
  const res = sh('claude', ['-p', task.prompt, '--output-format', 'json',
    '--model', MODEL, '--permission-mode', 'bypassPermissions'], { cwd: workdir, env })
  const wallMs = Date.now() - started

  let json = null
  try { json = JSON.parse(res.stdout) } catch { /* crashed or timed out */ }

  // Keep the answer itself, not just its size. Cost is only half the question:
  // a cheaper arm that answers worse is a regression, and bytes cannot tell
  // the difference. These files are what scripts/ab-judge.mjs grades blind.
  const answer = path.join(workdir, 'ANSWER.md')
  const answerBytes = fs.existsSync(answer) ? fs.statSync(answer).size : 0
  let answerPath = null
  if (answerBytes) {
    const kept = path.join(OUT, 'answers', `${task.name}-${arm}-${rep}.md`)
    fs.mkdirSync(path.dirname(kept), { recursive: true })
    fs.copyFileSync(answer, kept)
    answerPath = path.relative(OUT, kept)
  }

  return {
    arm, task: task.name, repo: task.repo, rep, wallMs,
    // 'read-heavy' is where cork-ai should win; 'adverse' is ordinary work
    // where it pays its overhead for little gain. Averaging the two hides
    // both, so the profile travels with the row and the report splits on it.
    profile: task.profile ?? 'read-heavy',
    ok: !!json && !json.is_error,
    costUSD: json?.total_cost_usd ?? null,
    turns: json?.num_turns ?? null,
    usage: json?.usage ?? null,
    // Which models actually ran, and on what price basis. The two arms read
    // different settings files -- the control's is empty by construction --
    // so they could silently end up on different models, and a cost
    // difference between two models is not a fact about cork-ai. Recorded so
    // the comparison can be checked rather than assumed.
    models: json?.modelUsage ? Object.keys(json.modelUsage).sort() : null,
    costBasis: json?.modelUsage ? [...new Set(Object.values(json.modelUsage).map(m => m.costBasis))].sort() : null,
    answerBytes, answerPath,
    ...(arm === 'treatment' ? corkActivity(home) : {}),
    stderr: json ? '' : (res.stderr ?? '').slice(-400),
  }
}

function main() {
  const repos = {
    'cork-ai': '/home/mathys/projects/cork-ai',
    'essenly': '/home/mathys/projects/marie-beauty',
  }
  const tasks = TASKS.filter(t => (!ONLY.length || ONLY.includes(t.name)) && fs.existsSync(repos[t.repo]))
  fs.mkdirSync(OUT, { recursive: true })

  // Prove, before and after, that the user's repositories are untouched.
  const before = {}
  for (const [name, p] of Object.entries(repos)) before[name] = fingerprint(p)
  fs.writeFileSync(path.join(OUT, 'repo-fingerprint-before.json'), JSON.stringify(before, null, 2))

  const resultsPath = path.join(OUT, 'results.jsonl')
  const done = loadCompletePairs(resultsPath)
  const remaining = tasks.length * REPEATS - done.size
  console.log(`${tasks.length} task(s) x ${REPEATS} repeat(s) x 2 arms = ${tasks.length * REPEATS * 2} runs`)
  if (done.size) console.log(`${done.size} pair(s) already done; ${remaining * 2} run(s) left.`)
  console.log(`Your repositories are never modified: every run works on its own copy.\n`)
  console.log(`Both arms run --model ${MODEL}\n`)
  warnIfStaleInstall()

  if (DRY) {
    for (const t of tasks) console.log(`  ${t.name.padEnd(20)} ${t.repo.padEnd(14)} ${t.prompt.length} chars`)
    console.log('\n--dry-run: nothing launched, nothing consumed.')
    return
  }

  const results = []
  let consecutiveFailures = 0
  const totalRuns = remaining * 2
  let runIdx = 0
  let spentUSD = 0
  const t0 = Date.now()
  for (const task of tasks) {
    for (let rep = 0; rep < REPEATS; rep++) {
      if (done.has(`${task.name}#${rep}`)) continue
      for (const arm of (rep % 2 === 0 ? ['treatment', 'control'] : ['control', 'treatment'])) {
        const workdir = path.join(OUT, 'work', `${task.name}-${arm}-${rep}`)
        fs.rmSync(workdir, { recursive: true, force: true })
        runIdx++
        const label = `  [${String(runIdx).padStart(2)}/${totalRuns}] ${task.name.padEnd(20)} rep${rep} ${arm.padEnd(9)}`
        process.stdout.write(`${label} copying...`)
        try { copyRepo(repos[task.repo], workdir) }
        catch (e) { console.log(`\r${label} copy failed: ${e.message}`); continue }

        // A run takes minutes of total silence: spawnSync blocks this process
        // entirely, so the ticker has to live in a child that owns the line
        // until the run returns. Without it the terminal looks hung, and the
        // honest reaction to a hung terminal is to kill it -- which would
        // throw away a paid run.
        const ticker = startTicker(label)
        const r = runArm({ arm, task, rep, workdir })
        stopTicker(ticker)
        results.push(r)
        fs.appendFileSync(resultsPath, JSON.stringify(r) + '\n')
        spentUSD += r.costUSD ?? 0
        const cork = r.arm === 'treatment' ? `  ${r.compressions} compressed` : ''
        const eta = etaFor(t0, runIdx, totalRuns)
        console.log(`\r${label} ${r.ok ? '' : 'FAILED '}$${(r.costUSD ?? 0).toFixed(4)}  ${String(r.turns ?? '?').padStart(3)} turns${cork}  ${(r.answerBytes/1024).toFixed(1)}KB  ${Math.round(r.wallMs/1000)}s  | $${spentUSD.toFixed(2)} spent${eta}`)

        // The copy has served its purpose; a repo copy per run fills a disk fast.
        fs.rmSync(workdir, { recursive: true, force: true })

        if (r.ok) { consecutiveFailures = 0; continue }
        consecutiveFailures++
        if (looksLikeUsageLimit(r) || consecutiveFailures >= 3) {
          console.log(`\n  Stopping: ${looksLikeUsageLimit(r) ? 'usage limit reached' : '3 failures in a row'}.`)
          return finish(results, resultsPath, repos, before)
        }
      }
    }
  }
  return finish(results, resultsPath, repos, before)
}

const MAX_CONSECUTIVE_FAILURES = 3
function looksLikeUsageLimit(r) {
  if (r.costUSD !== null) return false
  return /usage limit|rate limit|quota|too many requests|429/i.test(r.stderr ?? '')
}

function loadCompletePairs(resultsPath) {
  const done = new Set()
  if (!fs.existsSync(resultsPath)) return done
  const prior = fs.readFileSync(resultsPath, 'utf-8').trim().split('\n')
    .filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  for (const r of prior.filter(r => r.ok && r.arm === 'treatment')) {
    if (prior.some(c => c.ok && c.arm === 'control' && c.task === r.task && c.rep === r.rep)) done.add(`${r.task}#${r.rep}`)
  }
  return done
}

function warnIfStaleInstall() {
  let hookCmd = null
  try {
    const sp = path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude'), 'settings.json')
    const raw = JSON.parse(fs.readFileSync(sp, 'utf-8'))
    for (const group of Object.values(raw.hooks ?? {}).flat()) {
      for (const h of group.hooks ?? []) if (/cork-ai/.test(h.command ?? '')) { hookCmd = h.command; break }
    }
  } catch { /* none */ }
  if (!hookCmd) { console.log('!  No cork-ai hook found — the treatment arm would equal the control.\n'); return }
  const bin = hookCmd.split('"').filter(Boolean)[0]
  const installed = sh(bin, ['--version'], { timeout: 20_000 }).stdout?.trim()
  let local = null
  try { local = fs.readFileSync(path.join(process.cwd(), 'src/cli/version.ts'), 'utf-8').match(/VERSION = '([^']+)'/)?.[1] } catch { /* not in repo */ }
  if (local && installed && !installed.includes(local)) {
    console.log(`!  The hook runs ${installed}, but this tree is ${local}.`)
    console.log(`!  The treatment arm would measure the INSTALLED build, not your changes.\n`)
  } else if (installed) console.log(`Treatment arm runs ${installed}\n`)
}

/** Re-fingerprint the user's repos and shout if anything moved. */
function finish(results, resultsPath, repos, before) {
  console.log(`\n${results.length} run(s) this session, appended to ${resultsPath}`)
  let clean = true
  for (const [name, p] of Object.entries(repos)) {
    const after = fingerprint(p)
    const b = before[name]
    if (!b || !after) continue
    if (b.head !== after.head || b.dirty !== after.dirty) {
      clean = false
      console.log(`\n  !! ${name} CHANGED during the run — this should be impossible.`)
      console.log(`     HEAD ${b.head.slice(0,8)} -> ${after.head.slice(0,8)}, dirty ${b.dirtyCount} -> ${after.dirtyCount}`)
    }
  }
  if (clean) console.log(`Your repositories are byte-for-byte unchanged (HEAD and working tree verified).`)
  console.log(`Analyse with: node scripts/ab-report.mjs ${resultsPath}`)
  console.log(`Grade the answers blind with: node scripts/ab-judge.mjs ${OUT}`)
}

main()
