import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DIGEST_MAX_AGE_DAYS, latestDigest, listDigests, pruneDigests, writeDigest, type SessionDigest } from '../../src/cli/digests.js'

let dir: string
const NOW = new Date('2026-09-09T12:00:00Z')

function digest(id: string, endedAt: string, extra: Partial<SessionDigest> = {}): SessionDigest {
  return { sessionId: id, endedAt, turns: 10, avgContextTokens: 100_000, maxContextTokens: 200_000, costUSD: 1, cappedCost200kUSD: 0.8, compactions: 0, compressions: 1, reReads: 0, editFailures: 0, savedTokens: 2_000, guardBands: [], ...extra }
}

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cork-digests-')) })
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

describe('digests', () => {
  it('écrit, liste du plus récent au plus ancien, et donne le dernier', () => {
    writeDigest(digest('a', '2026-09-08T10:00:00Z'), NOW, dir)
    writeDigest(digest('b', '2026-09-09T10:00:00Z', { project: 'cork-ai' }), NOW, dir)
    writeDigest(digest('c/../x', '2026-09-07T10:00:00Z'), NOW, dir)  // the id is sanitised into the file name
    expect(fs.readdirSync(dir).sort()).toEqual(['a.json', 'b.json', 'c_.._x.json'])
    expect(listDigests(dir).map(d => d.sessionId)).toEqual(['b', 'a', 'c/../x'])
    expect(latestDigest(dir)).toMatchObject({ sessionId: 'b', project: 'cork-ai' })
  })

  it('purge au-delà de 30 jours à l’écriture, ignore les fichiers illisibles', () => {
    const old = new Date(NOW.getTime() - (DIGEST_MAX_AGE_DAYS + 1) * 86_400_000).toISOString()
    const fresh = new Date(NOW.getTime() - (DIGEST_MAX_AGE_DAYS - 1) * 86_400_000).toISOString()
    writeDigest(digest('old', old), new Date(0), dir)  // written "back then": not pruned yet
    writeDigest(digest('fresh', fresh), new Date(0), dir)
    fs.writeFileSync(path.join(dir, 'broken.json'), '{not json')
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'keep me')
    expect(fs.existsSync(path.join(dir, 'old.json'))).toBe(true)
    writeDigest(digest('now', NOW.toISOString()), NOW, dir)
    expect(fs.existsSync(path.join(dir, 'old.json'))).toBe(false)
    expect(fs.existsSync(path.join(dir, 'fresh.json'))).toBe(true)
    expect(fs.existsSync(path.join(dir, 'notes.txt'))).toBe(true)
    expect(listDigests(dir).map(d => d.sessionId)).toEqual(['now', 'fresh'])
    // an unreadable digest is judged by its mtime: recent → kept, and never listed
    expect(fs.existsSync(path.join(dir, 'broken.json'))).toBe(true)
  })

  it('un répertoire absent : liste vide, purge à zéro', () => {
    const none = path.join(dir, 'none')
    expect(listDigests(none)).toEqual([])
    expect(pruneDigests(NOW, none)).toBe(0)
    expect(latestDigest(none)).toBeUndefined()
  })
})
