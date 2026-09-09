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
 * the commands only read the cache. One line, at the end, nothing else:
 * visible when the install is behind, dim and rare when it only invites.
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

export interface KnownRelease { tag: string; version: string }

export interface UpdateCheck {
  checkedAt: string
  /** Newest release GitHub does not mark as pre-release. */
  stable?: KnownRelease
  /** Newest release of all, pre-releases included (equals `stable` when no candidate is newer). */
  pre?: KnownRelease
  /** When the "a release candidate is out" invitation was last shown. */
  preNoticedAt?: string
}

/** How often a stable install is invited to try a release candidate it is not behind on. */
export const PRE_NOTICE_INTERVAL_MS = 3 * 24 * 60 * 60 * 1000

/** Which channel this install follows: explicit choice, environment, or implied by running a pre-release. */
export function channelFor(installed = VERSION, configured?: Channel, env: NodeJS.ProcessEnv = process.env): Channel {
  if (configured === 'pre' || configured === 'stable') return configured
  if (env.CORK_AI_PRERELEASE && !/^(0|false|no|off)$/i.test(env.CORK_AI_PRERELEASE)) return 'pre'
  return installed.includes('-') ? 'pre' : 'stable'
}

export function readUpdateCheck(): UpdateCheck | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(UPDATE_CHECK_FILE, 'utf-8')) as Partial<UpdateCheck>
    const ok = (r: unknown): r is KnownRelease => typeof r === 'object' && r !== null && typeof (r as KnownRelease).version === 'string' && typeof (r as KnownRelease).tag === 'string'
    if (typeof raw.checkedAt !== 'string' || (!ok(raw.stable) && !ok(raw.pre))) return undefined
    return { checkedAt: raw.checkedAt, stable: ok(raw.stable) ? raw.stable : undefined, pre: ok(raw.pre) ? raw.pre : undefined, preNoticedAt: typeof raw.preNoticedAt === 'string' ? raw.preNoticedAt : undefined }
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
  return now.getTime() - new Date(last.checkedAt).getTime() > UPDATE_CHECK_INTERVAL_MS
}

export interface Notice {
  kind: 'behind' | 'candidate'
  line: string
}

export interface NoticeStyle { warn: (s: string) => string; dim: (s: string) => string; cmd: (s: string) => string }
const plain: NoticeStyle = { warn: s => s, dim: s => s, cmd: s => s }

/**
 * The one line a command prints, if any.
 *
 * `behind`: the install is older than the newest release on its channel —
 * visible, because staying behind costs the user real fixes.
 * `candidate`: a stable install is up to date, but a release candidate is
 * out — a soft invitation, at most once every PRE_NOTICE_INTERVAL_MS, so it
 * never turns into nagging. The caller records when it was shown.
 */
export function updateNotice(installed = VERSION, channel: Channel = channelFor(installed, loadConfig().channel), check = readUpdateCheck(), now: Date = new Date(), style: NoticeStyle = plain): Notice | undefined {
  if (!check) return undefined
  const target = channel === 'pre' ? (check.pre ?? check.stable) : check.stable
  if (target && compareVersions(target.version, installed) > 0) {
    const isPre = target.version.includes('-')
    return { kind: 'behind', line: `  ${style.warn('!')}  ${target.tag}${isPre ? ' (pre-release)' : ''} is available · installed v${installed} · ${style.cmd('cork-ai update')}` }
  }
  if (channel === 'stable' && check.pre && check.pre.version.includes('-') && compareVersions(check.pre.version, installed) > 0) {
    const shownAt = check.preNoticedAt ? new Date(check.preNoticedAt).getTime() : 0
    if (now.getTime() - shownAt < PRE_NOTICE_INTERVAL_MS) return undefined
    return { kind: 'candidate', line: `${style.dim(`  ·  Release candidate ${check.pre.tag} is out — try it with`)} ${style.cmd('cork-ai update --pre')} ${style.dim('(')}${style.cmd('--stable')}${style.dim(' goes back)')}` }
  }
  return undefined
}

/** Remembers that the candidate invitation was shown, so it waits its interval before coming back. */
export function markPreNoticed(now: Date = new Date()): void {
  const check = readUpdateCheck()
  if (check) writeUpdateCheck({ ...check, preNoticedAt: now.toISOString() })
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
