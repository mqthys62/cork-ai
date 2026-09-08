/**
 * Regression: files that live next to the live sessions but are not sessions.
 * `reads-<id>.json` crashed `gain` in 0.4.0 and `guard-<id>.json` in 0.7.0,
 * both on `undefined.localeCompare` inside the activity sort.
 */
import fs from 'fs'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LIVE_DIR, accumulateInSession, clearLiveSession, readActiveLiveSessions, readLiveSession } from '../../src/cli/persistent-stats.js'

const now = () => new Date().toISOString()

beforeEach(() => {
  clearLiveSession()
  fs.mkdirSync(LIVE_DIR, { recursive: true })
  for (const f of fs.readdirSync(LIVE_DIR)) fs.unlinkSync(path.join(LIVE_DIR, f))
})
afterEach(() => {
  for (const f of fs.readdirSync(LIVE_DIR)) fs.unlinkSync(path.join(LIVE_DIR, f))
})

describe('live directory hygiene', () => {
  it('ignore reads-*, guard-*, les formes inconnues et les fichiers corrompus sans planter ni les supprimer', () => {
    const real = {
      sessionId: 'aaaaaaaa-0000-0000-0000-000000000001', projectPath: '/p', startedAt: now(), lastActivityAt: now(),
      requests: 1, originalTokens: 10, compressedTokens: 5, savedTokens: 5, estimatedCostSaved: 0, byModule: {},
    }
    fs.writeFileSync(path.join(LIVE_DIR, `${real.sessionId}.json`), JSON.stringify(real))
    fs.writeFileSync(path.join(LIVE_DIR, 'reads-aaaaaaaa-0000-0000-0000-000000000001.json'), JSON.stringify({ files: { '/p/a.ts': 1 } }))
    fs.writeFileSync(path.join(LIVE_DIR, 'guard-aaaaaaaa-0000-0000-0000-000000000001.json'), JSON.stringify({ notified: [150000], toolUses: 3 }))
    fs.writeFileSync(path.join(LIVE_DIR, 'future-thing.json'), JSON.stringify({ hello: 'world' }))
    fs.writeFileSync(path.join(LIVE_DIR, 'corrupt.json'), '{not json')

    expect(() => readActiveLiveSessions()).not.toThrow()
    expect(readActiveLiveSessions().map(s => s.sessionId)).toEqual([real.sessionId])
    expect(readLiveSession()?.sessionId).toBe(real.sessionId)

    // accumulateInSession flushes expired sessions: it must not touch the other files
    accumulateInSession({ projectPath: '/p', originalTokens: 1, compressedTokens: 1, savedTokens: 0, estimatedCostSaved: 0, byModule: {}, sessionId: real.sessionId })
    for (const f of ['reads-aaaaaaaa-0000-0000-0000-000000000001.json', 'guard-aaaaaaaa-0000-0000-0000-000000000001.json', 'future-thing.json', 'corrupt.json']) {
      expect(fs.existsSync(path.join(LIVE_DIR, f)), f).toBe(true)
    }
    expect(fs.readFileSync(path.join(LIVE_DIR, 'guard-aaaaaaaa-0000-0000-0000-000000000001.json'), 'utf-8')).toContain('150000')
  })
})
