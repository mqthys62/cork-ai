#!/usr/bin/env node
/**
 * Fleet collector — runs on a workstation, writes one report for the fleet
 * dashboard to read.
 *
 *   node collect.mjs --out /mnt/fleet-reports      # a shared folder
 *   node collect.mjs --post https://fleet.corp/ingest --token "$FLEET_TOKEN"
 *
 * Reads what cork-ai already keeps on this machine — nothing is fetched from
 * the internet, and no PostHog key exists anywhere in this directory. The
 * telemetry cork-ai sends to its author is a separate, anonymous, opt-in
 * channel; this tool neither reads it nor needs it.
 *
 * What leaves the workstation is controlled by --privacy, and the default
 * already drops absolute paths (see sanitise below).
 *
 * Node >= 18. No dependencies.
 */

import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

// ─── workstation identity ────────────────────────────────────────────────────

/**
 * Which cork-ai binary to ask. `cork-ai` on PATH is right almost always; the
 * exception that actually bites is WSL, where a Windows install can shadow the
 * Linux one (or the reverse) and the two keep entirely separate stats.
 */
function resolveBinary(explicit) {
  if (explicit) return explicit
  if (process.env.CORK_AI_BIN) return process.env.CORK_AI_BIN
  return 'cork-ai'
}

/**
 * Where cork-ai keeps its state for the user running this script.
 *
 * WSL matters here and is easy to get wrong: under WSL, `os.homedir()` is the
 * Linux home (/home/alice), and a cork-ai installed inside WSL writes there —
 * NOT to the Windows profile. The same person running cork-ai in PowerShell
 * has a second, unrelated ~/.cork-ai under C:\Users\alice. They are two
 * installs with two ids and two sets of numbers, and a fleet that counts them
 * as one person will be wrong in both directions. So the report says which
 * environment it came from, and the dashboard can show them apart.
 */
function corkHome() {
  return process.env.CORK_AI_HOME || path.join(os.homedir(), '.cork-ai')
}

/** `wsl` when running inside WSL, else the plain platform. */
function environmentKind() {
  if (process.platform !== 'linux') return process.platform
  if (process.env.WSL_DISTRO_NAME) return 'wsl'
  // WSL1 and some setups do not export WSL_DISTRO_NAME; the kernel string does.
  try {
    if (/microsoft/i.test(fs.readFileSync('/proc/version', 'utf-8'))) return 'wsl'
  } catch { /* not linux-with-procfs */ }
  return 'linux'
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')) } catch { return null }
}

/** The install id, read straight from the config — never minted here. */
function installId() {
  return readJson(path.join(corkHome(), 'config.json'))?.installId ?? null
}

// ─── privacy ─────────────────────────────────────────────────────────────────

/**
 * `cork-ai report --json` is a local report and holds absolute paths
 * (`/home/alice/work/acme-payments`). That is fine on the machine it came
 * from and much less fine in a folder the whole company reads, so the default
 * keeps the project's own name and drops the path that leads to it.
 *
 *   full     everything, paths included — for a single machine you own
 *   default  project basenames, no paths          ← the default
 *   minimal  no project names at all, totals only
 */
function sanitise(report, level) {
  if (level === 'full') return report
  const basename = p => (typeof p === 'string' && p ? path.basename(p.replace(/[\\/]+$/, '')) : undefined)

  // A walk rather than a list of known places. `report --json` grew over
  // several versions and paths turn up in sessions, in projects, and in
  // whatever the next version adds; enumerating the spots I happen to know
  // today is how a path ends up in a folder the whole company can read.
  const PATH_KEYS = new Set(['projectPath', 'path', 'cwd', 'transcriptPath', 'file', 'filePath'])
  const NAME_KEYS = new Set(['project', 'projectName'])
  const ID_KEYS = new Set(['sessionId'])

  const walk = node => {
    if (Array.isArray(node)) return node.map(walk)
    if (!node || typeof node !== 'object') return node
    const out = {}
    for (const [k, v] of Object.entries(node)) {
      if (PATH_KEYS.has(k)) {
        // Keep the leaf name (that is the project), drop the road to it.
        if (level !== 'minimal' && typeof v === 'string' && node.projectName === undefined && node.project === undefined) {
          const name = basename(v)
          if (name) out.projectName = name
        }
        continue
      }
      if (level === 'minimal' && NAME_KEYS.has(k)) continue
      // Local and random, but still a join key across reports, and nothing
      // in the dashboard needs it.
      if (ID_KEYS.has(k)) continue
      out[k] = walk(v)
    }
    return out
  }
  return walk(report)
}

// ─── report ──────────────────────────────────────────────────────────────────

function buildReport(opts) {
  const bin = resolveBinary(opts.bin)
  let report
  try {
    const raw = execFileSync(bin, ['report', '--json'], { encoding: 'utf-8', timeout: 60_000, maxBuffer: 64 * 1024 * 1024 })
    report = JSON.parse(raw)
  } catch (err) {
    const why = err.code === 'ENOENT'
      ? `cork-ai not found (tried "${bin}"). Pass --bin /path/to/cork-ai, or set CORK_AI_BIN.`
      : String(err.message ?? err).slice(0, 300)
    throw new Error(why)
  }

  const id = installId()
  if (!id) {
    // No install id means telemetry was never enabled on this machine. That is
    // fine — the fleet dashboard does not need cork-ai's telemetry — but the
    // id is how a workstation is recognised across reports, so we fall back to
    // a stable local name rather than inventing an identifier.
    process.stderr.write('  note: no install id (telemetry never enabled here) — identifying this machine by host + user\n')
  }

  return {
    schema: 'cork-ai.fleet.report/1',
    generatedAt: new Date().toISOString(),
    privacy: opts.privacy,
    machine: {
      installId: id,
      // Falls back to something stable so two reports from the same
      // workstation land on the same row even without an install id.
      key: id ?? `${os.hostname()}/${os.userInfo().username}`,
      hostname: opts.anonymousHost ? undefined : os.hostname(),
      user: opts.anonymousHost ? undefined : os.userInfo().username,
      environment: environmentKind(),
      platform: process.platform,
      arch: process.arch,
      corkHome: opts.privacy === 'full' ? corkHome() : undefined,
    },
    cork: {
      version: (() => { try { return execFileSync(bin, ['--version'], { encoding: 'utf-8', timeout: 15_000 }).trim() } catch { return null } })(),
      autoCompactWindow: readClaudeSetting('autoCompactWindow'),
      telemetry: readJson(path.join(corkHome(), 'config.json'))?.telemetry ?? null,
    },
    report: sanitise(report, opts.privacy),
  }
}

/** One value out of Claude Code's own settings.json, for context. */
function readClaudeSetting(key) {
  const dir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
  return readJson(path.join(dir, 'settings.json'))?.[key] ?? null
}

// ─── delivery ────────────────────────────────────────────────────────────────

/** Writes the report into a folder, atomically, named after the machine key. */
function deliverFile(payload, dir) {
  fs.mkdirSync(dir, { recursive: true })
  const safe = payload.machine.key.replace(/[^\w.@-]/g, '_').slice(0, 100)
  const dest = path.join(dir, `${safe}.json`)
  const tmp = `${dest}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2))
  // Rename is atomic on a local disk. On some network shares it is not, and
  // the dashboard may briefly read a half-written file; it skips unparseable
  // files rather than crashing, so the next run repairs it.
  try { fs.renameSync(tmp, dest) }
  catch { fs.writeFileSync(dest, JSON.stringify(payload, null, 2)); try { fs.unlinkSync(tmp) } catch { /* gone */ } }
  return dest
}

async function deliverPost(payload, url, token) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`)
  return url
}

// ─── cli ─────────────────────────────────────────────────────────────────────

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback
}
const has = name => process.argv.includes(`--${name}`)

if (has('help') || process.argv.length === 2) {
  console.log(`
  cork-ai fleet collector — reads this machine's cork-ai stats, writes one report.

    node collect.mjs --out <folder>          write the report into a shared folder
    node collect.mjs --post <url> [--token]  POST it to an ingestion endpoint
    node collect.mjs --stdout                print it, deliver nothing

  Options
    --privacy full|default|minimal   what leaves this machine (default: default)
                                     default  project names, no paths
                                     minimal  no project names at all
                                     full     everything, paths included
    --anonymous-host                 omit hostname and user name
    --bin <path>                     path to cork-ai (default: cork-ai on PATH,
                                     or CORK_AI_BIN)

  No PostHog key, no account, no network call other than --post.
  Under WSL this reports the WSL install; a Windows cork-ai is a separate one.
`)
  process.exit(0)
}

const opts = {
  privacy: ['full', 'default', 'minimal'].includes(arg('privacy')) ? arg('privacy') : 'default',
  anonymousHost: has('anonymous-host'),
  bin: arg('bin'),
}

try {
  const payload = buildReport(opts)
  if (has('stdout')) { console.log(JSON.stringify(payload, null, 2)); process.exit(0) }

  const out = arg('out')
  const post = arg('post')
  if (!out && !post) {
    console.error('\n  Nothing to do: pass --out <folder>, --post <url>, or --stdout. See --help.\n')
    process.exit(1)
  }
  if (out) console.log(`  ✔ ${deliverFile(payload, out)}`)
  if (post) { await deliverPost(payload, post, arg('token') ?? process.env.FLEET_TOKEN); console.log(`  ✔ posted to ${post}`) }
} catch (err) {
  console.error(`\n  ${String(err.message ?? err)}\n`)
  process.exit(1)
}
