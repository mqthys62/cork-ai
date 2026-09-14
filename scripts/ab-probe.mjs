#!/usr/bin/env node
/**
 * Which tasks actually exercise cork-ai?
 *
 * The first real pair cost $2.20 to discover that neither arm ever called
 * Read: the task solved itself through Bash, cork-ai compressed nothing, and
 * the cost difference measured agent variance. Running 60 paired runs to
 * learn that about ten tasks would be far more expensive.
 *
 * This probes the treatment arm only — half the cost of a pair — and reports
 * what cork-ai actually did. Tasks with zero compressions do not belong in
 * the benchmark, whatever their file sizes say.
 */
import { spawnSync } from 'child_process'
import fs from 'fs'
import path from 'path'

const ROOT = process.env.SKILLSBENCH_DIR
const OUT = process.env.PROBE_OUT
const TIMEOUT = Number(process.env.PROBE_TIMEOUT_MS ?? 420_000)
const tasks = (process.env.PROBE_TASKS ?? '').split(',').filter(Boolean)

function workdirFor(task) {
  const df = path.join(ROOT, 'tasks', task, 'environment', 'Dockerfile')
  const lines = fs.existsSync(df) ? fs.readFileSync(df, 'utf-8').split('\n') : []
  const last = lines.filter(l => /^WORKDIR\s/.test(l)).pop()
  const dir = last?.trim().split(/\s+/)[1]
  return dir && !dir.includes('$') ? dir : '/root'
}

fs.mkdirSync(OUT, { recursive: true })
console.log(`Probing ${tasks.length} task(s), treatment arm only.\n`)

for (const task of tasks) {
  const taskDir = path.join(ROOT, 'tasks', task)
  if (!fs.existsSync(taskDir)) { console.log(`  ${task}: not found`); continue }
  const work = path.join(OUT, 'work', task)
  const home = path.join(OUT, 'homes', task)
  fs.rmSync(work, { recursive: true, force: true })
  fs.rmSync(home, { recursive: true, force: true })
  fs.mkdirSync(path.dirname(work), { recursive: true })
  fs.cpSync(path.join(taskDir, 'environment'), work, { recursive: true })
  fs.mkdirSync(home, { recursive: true })

  const wd = workdirFor(task)
  const prompt = fs.readFileSync(path.join(taskDir, 'task.md'), 'utf-8')
    .replace(/^---[\s\S]*?\n---\n/, '').trim()
    .split(wd + '/').join(work + '/').split(wd).join(work)

  const env = { ...process.env, CORK_AI_HOME: home }
  delete env.ANTHROPIC_API_KEY
  delete env.ANTHROPIC_AUTH_TOKEN

  process.stdout.write(`  ${task.padEnd(32)} `)
  const started = Date.now()
  const res = spawnSync('claude', ['-p', prompt, '--output-format', 'json',
    '--permission-mode', 'bypassPermissions'], { cwd: work, env, encoding: 'utf-8', timeout: TIMEOUT })
  let json = null
  try { json = JSON.parse(res.stdout) } catch { /* killed */ }

  let compressions = 0, saved = 0, reReads = 0, turns = json?.num_turns ?? null
  try {
    for (const f of fs.readdirSync(path.join(home, 'digests'))) {
      const d = JSON.parse(fs.readFileSync(path.join(home, 'digests', f), 'utf-8'))
      compressions += d.compressions ?? 0; saved += d.savedTokens ?? 0; reReads += d.reReads ?? 0
    }
  } catch { /* nothing ran */ }

  const row = { task, ok: !!json, costUSD: json?.total_cost_usd ?? null, turns,
    compressions, savedTokens: saved, reReads, wallMs: Date.now() - started }
  fs.appendFileSync(path.join(OUT, 'probe.jsonl'), JSON.stringify(row) + '\n')
  console.log(`${json ? '' : 'KILLED '}$${(row.costUSD ?? 0).toFixed(4)}  ${String(turns ?? '?').padStart(3)} turns  ${String(compressions).padStart(3)} compressed  ${saved.toLocaleString()} saved  ${Math.round(row.wallMs/1000)}s`)
}
console.log(`\nWritten to ${path.join(OUT, 'probe.jsonl')}`)
