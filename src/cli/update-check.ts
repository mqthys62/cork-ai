/**
 * Update channel and the discreet "a newer version exists" line.
 *
 * GitHub keeps `/releases/latest` clear of pre-releases, so a stable install
 * never sees a release candidate unless it asks. Asking is the `pre` channel:
 * `cork-ai update --pre` switches to it (and remembers), the installers do the
 * same under `CORK_AI_PRERELEASE=1`, and an install that already runs a
 * pre-release follows it implicitly — rc.1 must see rc.2.
 *
 * The notice never costs a command a network round trip: a detached child
 * (`cork-ai __check-update`) refreshes a small cache at most once a day, and
 * the commands only read the cache. One dim line, at the end, nothing else.
 */

import { spawn } from 'child_process'
import fs from 'fs'
import path from 'path'
import { CORK_HOME, loadConfig } from './config.js'
import { writeFileAtomic } from './fs-utils.js'
import { VERSION, compareVersions } from './version.js'

export type Channel = 'stable' | 'pre'

export const UPDATE_CHECK_FILE = path.join(CORK_HOME, 'update-check.json')
export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000

export interface UpdateCheck {
  checkedAt: string
  tag: string
  version: string
  prerelease: boolean
  channel: Channel
}

/** Which channel this install follows: explicit choice, environment, or implied by running a pre-release. */
export function channelFor(installed = VERSION, configured?: Channel, env: NodeJS.ProcessEnv = process.env): Channel {
  if (configured === 'pre' || configured === 'stable') return configured
  if (env.CORK_AI_PRERELEASE && !/^(0|false|no|off)$/i.test(env.CORK_AI_PRERELEASE)) return 'pre'
  return installed.includes('-') ? 'pre' : 'stable'
}

export function readUpdateCheck(): UpdateCheck | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(UPDATE_CHECK_FILE, 'utf-8')) as Partial<UpdateCheck>
    return typeof raw.version === 'string' && typeof raw.checkedAt === 'string' ? raw as UpdateCheck : undefined
  } catch { return undefined }
}

export function writeUpdateCheck(check: UpdateCheck): void {
  try { fs.mkdirSync(CORK_HOME, { recursive: true }) } catch { /* exists */ }
  writeFileAtomic(UPDATE_CHECK_FILE, JSON.stringify(check))
}

/** Whether the daily background check is due — off with `updateCheck: false` or `CORK_AI_NO_UPDATE_CHECK`. */
export function updateCheckDue(now: Date = new Date(), env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.CORK_AI_NO_UPDATE_CHECK || env.CI) return false
  if (loadConfig().updateCheck === false) return false
  const last = readUpdateCheck()
  if (!last) return true
  // a cache written for another channel is stale for this one
  if (last.channel !== channelFor(VERSION, loadConfig().channel, env)) return true
  return now.getTime() - new Date(last.checkedAt).getTime() > UPDATE_CHECK_INTERVAL_MS
}

/**
 * The one line a command prints when the cache says a newer version exists.
 * Undefined when up to date, when nothing was checked yet, or when the cache
 * belongs to another channel.
 */
export function updateNoticeLine(installed = VERSION, check = readUpdateCheck(), dim: (s: string) => string = s => s): string | undefined {
  if (!check || compareVersions(check.version, installed) <= 0) return undefined
  const what = check.prerelease ? `${check.tag} (pre-release)` : check.tag
  return dim(`  ↑ ${what} is available · installed v${installed} · cork-ai update${check.prerelease && !installed.includes('-') ? ' --pre' : ''}`)
}

/** Spawns the detached `cork-ai __check-update` child when the daily check is due. Never blocks, never throws. */
export function scheduleUpdateCheck(now: Date = new Date()): void {
  try {
    if (!updateCheckDue(now)) return
    const compiled = !/\b(node|bun)(\.exe)?$/i.test(path.basename(process.execPath))
    const args = compiled ? ['__check-update'] : [process.argv[1], '__check-update']
    const child = spawn(process.execPath, args, { detached: true, stdio: 'ignore', windowsHide: true })
    child.unref()
  } catch { /* a missing notice is not a problem */ }
}
