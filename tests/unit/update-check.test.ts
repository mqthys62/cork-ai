/**
 * update-check.ts — the channel an install follows and the one-line notice.
 * Runs against the throw-away CORK_AI_HOME from tests/setup.ts.
 */
import fs from 'fs'
import { afterEach, describe, expect, it } from 'vitest'
import { saveConfig } from '../../src/cli/config.js'
import { UPDATE_CHECK_FILE, channelFor, readUpdateCheck, updateCheckDue, updateNoticeLine, writeUpdateCheck } from '../../src/cli/update-check.js'

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

describe('updateNoticeLine', () => {
  const rc2 = { checkedAt: '2026-09-09T00:00:00Z', tag: 'v1.0.0-rc.2', version: '1.0.0-rc.2', prerelease: true, channel: 'pre' as const }
  it('rien sans cache, rien quand on est à jour ou en avance', () => {
    expect(updateNoticeLine('0.9.1', undefined)).toBeUndefined()
    expect(updateNoticeLine('1.0.0-rc.2', rc2)).toBeUndefined()
    expect(updateNoticeLine('1.0.0', rc2)).toBeUndefined()
  })
  it('une ligne quand une version plus récente existe, avec --pre pour une install stable vers une rc', () => {
    expect(updateNoticeLine('0.9.1', rc2)).toBe('  ↑ v1.0.0-rc.2 (pre-release) is available · installed v0.9.1 · cork-ai update --pre')
    expect(updateNoticeLine('1.0.0-rc.1', rc2)).toBe('  ↑ v1.0.0-rc.2 (pre-release) is available · installed v1.0.0-rc.1 · cork-ai update')
    const stable = { ...rc2, tag: 'v1.0.0', version: '1.0.0', prerelease: false, channel: 'stable' as const }
    expect(updateNoticeLine('0.9.1', stable, s => `<${s}>`)).toBe('<  ↑ v1.0.0 is available · installed v0.9.1 · cork-ai update>')
  })
})

describe('updateCheckDue', () => {
  it('dû sans cache, pas dû dans les 24 h, dû après, jamais si désactivé', () => {
    const now = new Date('2026-09-09T12:00:00Z')
    expect(updateCheckDue(now, {})).toBe(true)
    writeUpdateCheck({ checkedAt: '2026-09-09T02:00:00Z', tag: 'v0.9.1', version: '0.9.1', prerelease: false, channel: channelFor(undefined, undefined, {}) })
    expect(readUpdateCheck()?.version).toBe('0.9.1')
    expect(updateCheckDue(now, {})).toBe(false)
    expect(updateCheckDue(new Date('2026-09-10T13:00:00Z'), {})).toBe(true)
    expect(updateCheckDue(new Date('2026-09-10T13:00:00Z'), { CORK_AI_NO_UPDATE_CHECK: '1' })).toBe(false)
    saveConfig({ updateCheck: false })
    expect(updateCheckDue(new Date('2026-09-10T13:00:00Z'), {})).toBe(false)
  })
  it('un cache écrit pour l’autre canal est périmé', () => {
    const now = new Date('2026-09-09T12:00:00Z')
    const other = channelFor(undefined, undefined, {}) === 'pre' ? 'stable' : 'pre'
    writeUpdateCheck({ checkedAt: now.toISOString(), tag: 'v0.9.1', version: '0.9.1', prerelease: false, channel: other })
    expect(updateCheckDue(now, {})).toBe(true)
  })
})
