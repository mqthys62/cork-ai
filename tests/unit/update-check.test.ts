/**
 * update-check.ts — the channel an install follows and the one-line notice.
 * Runs against the throw-away CORK_AI_HOME from tests/setup.ts.
 */
import fs from 'fs'
import { afterEach, describe, expect, it } from 'vitest'
import { saveConfig } from '../../src/cli/config.js'
import { PRE_NOTICE_INTERVAL_MS, UPDATE_CHECK_FILE, channelFor, markPreNoticed, readUpdateCheck, updateCheckDue, updateNotice, writeUpdateCheck } from '../../src/cli/update-check.js'

afterEach(() => {
  try { fs.unlinkSync(UPDATE_CHECK_FILE) } catch { /* none */ }
  saveConfig({})
})

describe('channelFor', () => {
  it('stable par défaut, pre si l’install est déjà une pré-release', () => {
    expect(channelFor('0.9.1', undefined, {})).toBe('stable')
    expect(channelFor('1.0.0-rc.1', undefined, {})).toBe('pre')
    expect(channelFor('1.0.0', undefined, {})).toBe('stable')
  })
  it('le choix explicite gagne, puis la variable d’environnement', () => {
    expect(channelFor('1.0.0-rc.1', 'stable', {})).toBe('stable')
    expect(channelFor('0.9.1', 'pre', {})).toBe('pre')
    expect(channelFor('0.9.1', undefined, { CORK_AI_PRERELEASE: '1' })).toBe('pre')
    expect(channelFor('0.9.1', undefined, { CORK_AI_PRERELEASE: '0' })).toBe('stable')
    expect(channelFor('0.9.1', undefined, { CORK_AI_PRERELEASE: 'false' })).toBe('stable')
  })
})

describe('updateNotice', () => {
  const now = new Date('2026-09-09T12:00:00Z')
  const stable091 = { tag: 'v0.9.1', version: '0.9.1' }
  const rc2 = { tag: 'v1.0.0-rc.2', version: '1.0.0-rc.2' }
  const both = { checkedAt: '2026-09-09T00:00:00Z', stable: stable091, pre: rc2 }
  const style = { warn: (s: string) => `[${s}]`, dim: (s: string) => `<${s}>`, cmd: (s: string) => `{${s}}` }

  it('rien sans cache, rien quand on est à jour ou en avance sur son canal', () => {
    expect(updateNotice('0.9.1', 'stable', undefined, now)).toBeUndefined()
    expect(updateNotice('1.0.0-rc.2', 'pre', both, now)).toBeUndefined()
    expect(updateNotice('1.0.0', 'pre', both, now)).toBeUndefined()
    expect(updateNotice('1.0.0', 'stable', both, now)).toBeUndefined()
  })
  it('en retard sur son canal : une ligne visible avec cork-ai update', () => {
    expect(updateNotice('0.9.0', 'stable', both, now)).toEqual({ kind: 'behind', line: '  !  v0.9.1 is available · installed v0.9.0 · cork-ai update' })
    expect(updateNotice('1.0.0-rc.1', 'pre', both, now)).toEqual({ kind: 'behind', line: '  !  v1.0.0-rc.2 (pre-release) is available · installed v1.0.0-rc.1 · cork-ai update' })
    expect(updateNotice('0.9.0', 'stable', both, now, style)?.line).toBe('  [!]  v0.9.1 is available · installed v0.9.0 · {cork-ai update}')
  })
  it('à jour en stable mais une rc existe : une invitation douce, au plus une fois tous les trois jours', () => {
    const first = updateNotice('0.9.1', 'stable', both, now)
    expect(first?.kind).toBe('candidate')
    expect(first?.line).toBe('  ·  Release candidate v1.0.0-rc.2 is out — try it with cork-ai update --pre (--stable goes back)')
    const shown = { ...both, preNoticedAt: now.toISOString() }
    expect(updateNotice('0.9.1', 'stable', shown, new Date(now.getTime() + PRE_NOTICE_INTERVAL_MS - 1000))).toBeUndefined()
    expect(updateNotice('0.9.1', 'stable', shown, new Date(now.getTime() + PRE_NOTICE_INTERVAL_MS + 1000))?.kind).toBe('candidate')
  })
  it('le retard prime sur l’invitation, et une rc plus vieille que l’install n’invite pas', () => {
    expect(updateNotice('0.9.0', 'stable', both, now)?.kind).toBe('behind')
    expect(updateNotice('1.0.0', 'stable', { ...both, stable: { tag: 'v1.0.0', version: '1.0.0' } }, now)).toBeUndefined()
  })
  it('markPreNoticed garde le cache et date l’invitation', () => {
    writeUpdateCheck(both)
    markPreNoticed(now)
    expect(readUpdateCheck()).toEqual({ ...both, preNoticedAt: now.toISOString() })
  })
  it('readUpdateCheck ignore l’ancien format à cible unique', () => {
    fs.writeFileSync(UPDATE_CHECK_FILE, JSON.stringify({ checkedAt: '2026-09-09T00:00:00Z', tag: 'v0.9.1', version: '0.9.1', prerelease: false, channel: 'stable' }))
    expect(readUpdateCheck()).toBeUndefined()
    expect(updateCheckDue(now, {})).toBe(true)
  })
})

describe('updateCheckDue', () => {
  it('dû sans cache, pas dû dans les 24 h, dû après, jamais si désactivé', () => {
    const now = new Date('2026-09-09T12:00:00Z')
    expect(updateCheckDue(now, {})).toBe(true)
    writeUpdateCheck({ checkedAt: '2026-09-09T02:00:00Z', stable: { tag: 'v0.9.1', version: '0.9.1' } })
    expect(readUpdateCheck()?.stable?.version).toBe('0.9.1')
    expect(updateCheckDue(now, {})).toBe(false)
    expect(updateCheckDue(new Date('2026-09-10T13:00:00Z'), {})).toBe(true)
    expect(updateCheckDue(new Date('2026-09-10T13:00:00Z'), { CORK_AI_NO_UPDATE_CHECK: '1' })).toBe(false)
    saveConfig({ updateCheck: false })
    expect(updateCheckDue(new Date('2026-09-10T13:00:00Z'), {})).toBe(false)
  })
})
