/**
 * `cork-ai gain` picks the *last* Claude Code session, whatever cork-ai saw of
 * it. Spawns the real CLI (tsx) against a throwaway CORK_AI_HOME.
 */
import { spawnSync } from 'child_process'
import fs from 'fs'
import { createRequire } from 'module'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const CLI = path.resolve(__dirname, '../../src/cli/index.ts')
const TSX = createRequire(import.meta.url).resolve('tsx/cli')
let home: string
let corkHome: string

function run(...args: string[]): string {
  const res = spawnSync(process.execPath, [TSX, CLI, ...args], {
    encoding: 'utf-8',
    env: { ...process.env, HOME: home, USERPROFILE: home, CORK_AI_HOME: corkHome, CLAUDE_CONFIG_DIR: path.join(home, '.claude'), CLAUDE_PROJECTS_DIR: path.join(home, 'none'), NO_COLOR: '1' },
    input: '', timeout: 60_000, windowsHide: true,
  })
  // eslint-disable-next-line no-control-regex
  return ((res.stdout ?? '') + (res.stderr ?? '')).replace(/\x1b\[[0-9;]*m/g, '')
}

function record(sessionId: string, startedAt: string, endedAt: string, requests: number, saved: number) {
  return { sessionId, projectPath: '/p/app', startedAt, endedAt, requests, originalTokens: saved * 2, compressedTokens: saved, savedTokens: saved, savingsPercent: 50, estimatedCostSaved: saved / 1e6, byModule: { hookReadCompressor: saved } }
}

function seedStats(sessions: ReturnType<typeof record>[]): void {
  const allTime = { totalRequests: 0, totalOriginalTokens: 0, totalCompressedTokens: 0, totalSavedTokens: 0, estimatedCostSaved: 0 }
  for (const s of sessions) { allTime.totalRequests += s.requests; allTime.totalOriginalTokens += s.originalTokens; allTime.totalCompressedTokens += s.compressedTokens; allTime.totalSavedTokens += s.savedTokens; allTime.estimatedCostSaved += s.estimatedCostSaved }
  fs.writeFileSync(path.join(corkHome, 'stats.json'), JSON.stringify({ version: '2', createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z', allTime, sessions }))
}

function seedDigest(sessionId: string, endedAt: string, compressions: number): void {
  fs.mkdirSync(path.join(corkHome, 'digests'), { recursive: true })
  fs.writeFileSync(path.join(corkHome, 'digests', `${sessionId}.json`), JSON.stringify({
    sessionId, endedAt, reason: 'prompt_input_exit', model: 'claude-opus-5', turns: 40, avgContextTokens: 120_000, maxContextTokens: 200_000,
    costUSD: 3, cappedCost200kUSD: 3, compactions: 0, compressions, reReads: 0, editFailures: 0, savedTokens: 0, guardBands: [], project: 'app',
  }))
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'cork-gain-'))
  corkHome = path.join(home, '.cork-ai')
  fs.mkdirSync(corkHome, { recursive: true })
})
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }) })

describe('cork-ai gain — la dernière session, pas la dernière rafale flushée', () => {
  it('une session sans outline mais avec un digest est bien « la dernière »', () => {
    seedStats([record('old', '2026-09-01T10:00:00Z', '2026-09-01T11:00:00Z', 6, 100_000)])
    seedDigest('new', '2026-09-02T09:00:00Z', 0)
    const out = run('gain')
    expect(out).toContain('Last Session')
    expect(out).toContain('No outline in this session')
    expect(out).toContain('Session Digest')
    expect(out).not.toContain('Requests    6')
  })

  it('les rafales d’une même session sont additionnées et son digest est le sien', () => {
    seedStats([
      record('s1', '2026-09-03T08:00:00Z', '2026-09-03T09:00:00Z', 6, 100_000),
      record('s0', '2026-09-02T08:00:00Z', '2026-09-02T09:00:00Z', 2, 10_000),   // older, listed after: order must not matter
      record('s1', '2026-09-03T13:00:00Z', '2026-09-03T14:00:00Z', 12, 40_000),
    ])
    seedDigest('s0', '2026-09-02T09:30:00Z', 2)   // the latest digest belongs to another session: not shown
    const out = run('gain')
    expect(out).toContain('Requests    18')
    expect(out).toContain('140,000')
    expect(out).not.toContain('Session Digest')
    expect(out).toContain('No digest yet')
    expect(out).toMatch(/2 sessions\)/)
  })

  it('une rafale expirée mais pas encore flushée compte, et ne masque pas la session', () => {
    seedStats([record('a', '2026-09-01T10:00:00Z', '2026-09-01T11:00:00Z', 6, 100_000)])
    fs.mkdirSync(path.join(corkHome, 'live'), { recursive: true })
    const stale = { sessionId: 'a', projectPath: '/p/app', startedAt: '2026-09-01T15:00:00Z', lastActivityAt: '2026-09-01T15:30:00Z', requests: 3, originalTokens: 20_000, compressedTokens: 5_000, savedTokens: 15_000, estimatedCostSaved: 0.01, byModule: { hookReadCompressor: 15_000 } }
    fs.writeFileSync(path.join(corkHome, 'live', 'a.json'), JSON.stringify(stale))
    const out = run('gain')
    expect(out).toContain('Requests    9')
    expect(fs.existsSync(path.join(corkHome, 'live', 'a.json'))).toBe(false)   // flushed by gain itself
  })
})
