/**
 * savings.ts — the daily telemetry snapshot: what it aggregates and, above
 * all, what it must never contain. Runs against a throw-away CORK_AI_HOME
 * (vitest.setup) and a fixture transcript directory.
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { saveClaudeSettings } from '../../src/cli/claude-settings.js'
import { CONFIG_FILE, CORK_HOME, saveConfig } from '../../src/cli/config.js'
import { STATS_FILE } from '../../src/cli/persistent-stats.js'
import { buildSavingsSnapshot, projectsBucket, snapshotDue, SNAPSHOT_INTERVAL_MS } from '../../src/cli/savings.js'
import { capturePayload } from '../../src/cli/telemetry.js'

const now = new Date('2026-09-09T10:00:00Z')
let projects: string

beforeEach(() => {
  projects = fs.mkdtempSync(path.join(os.tmpdir(), 'cork-savings-'))
  process.env.CLAUDE_PROJECTS_DIR = projects
  fs.mkdirSync(CORK_HOME, { recursive: true })
  for (const f of [CONFIG_FILE, STATS_FILE, path.join(CORK_HOME, 'spend-cache.json'), path.join(CORK_HOME, 'analysis-cache.json')]) { try { fs.unlinkSync(f) } catch { /* none */ } }
  fs.writeFileSync(STATS_FILE, JSON.stringify({
    version: '2', createdAt: '2026-08-01T00:00:00Z', updatedAt: now.toISOString(),
    allTime: { totalRequests: 40, totalOriginalTokens: 400_000, totalCompressedTokens: 40_000, totalSavedTokens: 360_000, estimatedCostSaved: 1.8, reReads: 4, reReadTokensServed: 30_000, editFailuresAfterCompression: 1, byModel: { 'claude-opus-5': { requests: 30, originalTokens: 300_000, savedTokens: 270_000, costSaved: 1.35, lastUsedAt: now.toISOString() }, 'claude-sonnet-5': { requests: 10, originalTokens: 100_000, savedTokens: 90_000, costSaved: 0.18, lastUsedAt: now.toISOString() } } },
    sessions: [{ sessionId: 'sess-secret-1', projectPath: '/home/someone/secret-project', startedAt: '2026-09-01T00:00:00Z', endedAt: '2026-09-01T01:00:00Z', requests: 40, originalTokens: 400_000, compressedTokens: 40_000, savedTokens: 360_000, savingsPercent: 90, estimatedCostSaved: 1.8, byModule: {}, byModel: { 'claude-opus-5': { requests: 30, originalTokens: 300_000, savedTokens: 270_000, costSaved: 1.35, lastUsedAt: now.toISOString() } }, reReads: 4, reReadTokensServed: 30_000 }],
  }))
})

afterEach(() => {
  delete process.env.CLAUDE_PROJECTS_DIR
  fs.rmSync(projects, { recursive: true, force: true })
})

describe('projectsBucket', () => {
  it('tranches fixes, jamais le nombre exact au-delà de 1', () => {
    expect([0, 1, 2, 3, 4, 6, 7, 15, 16, 40].map(projectsBucket)).toEqual(['0', '1', '2-3', '2-3', '4-6', '4-6', '7-15', '7-15', '>15', '>15'])
  })
})

describe('buildSavingsSnapshot', () => {
  it('agrège les gains réels et ne contient ni chemin, ni nom de projet, ni identifiant de session', () => {
    const e = buildSavingsSnapshot('gain', now)
    expect(e.event).toBe('savings_snapshot')
    expect(e.properties).toMatchObject({
      reason: 'gain', tracking_days: 39, sessions: 1, requests: 40, read_raw_tokens: 400_000, saved_tokens: 360_000, saved_pct: 90,
      rereads: 4, reread_tokens: 30_000, reread_rate_pct: 10, edit_failures: 1, top_model: 'opus-5', models: 2,
      spend_30d: '<$1', turns_30d: 0, context_guard: true, hooks_installed: expect.any(Number), projects_30d: expect.stringMatching(/^(0|1|2-3|4-6|7-15|>15)$/),
    })
    expect(e.properties.saved_usd_first_pass).toBeGreaterThan(0)
    expect(e.properties.net_usd).toBeDefined()
    expect(e.set).toMatchObject({ lifetime_saved_tokens: 360_000, lifetime_sessions: 1, top_model: 'opus-5', telemetry: true, last_snapshot_at: now.toISOString() })
    expect(e.setOnce).toMatchObject({ first_seen: now.toISOString() })
    const wire = JSON.stringify(capturePayload(e, 'install-id', now))
    for (const forbidden of ['sess-secret', 'secret-project', '/home/', os.homedir(), 'claude-opus-5']) expect(wire).not.toContain(forbidden)
  })

  it('ne contient que des scalaires (pas d’objets imbriqués qui pourraient transporter un chemin)', () => {
    const e = buildSavingsSnapshot('preview', now)
    for (const bag of [e.properties, e.set ?? {}, e.setOnce ?? {}]) {
      for (const [key, value] of Object.entries(bag)) expect(['string', 'number', 'boolean', 'undefined'].includes(typeof value) || value === null, key).toBe(true)
    }
  })

  /**
   * The bug this guards: `saving_at_200k` was the only ceiling ever reported,
   * so someone running a 300k window was read as if they were at 200k — their
   * setting's real worth was nowhere in the data, and a 1M window (which never
   * fires) counted as "configured" just the same.
   */
  it('rapporte le plafond réellement réglé à côté du contrefactuel à 200k', () => {
    saveClaudeSettings({ autoCompactWindow: 300_000 })
    const e = buildSavingsSnapshot('gain', now)
    expect(e.properties.autocompact_window).toBe(300_000)
    expect(e.properties).toHaveProperty('saving_at_own_ceiling_pct_30d')
    expect(e.properties).toHaveProperty('autocompact_ceiling_inert')
    // 200k stays, unchanged and comparable across installs
    expect(e.properties.saving_at_200k_pct_30d).toEqual(expect.any(Number))
    expect(e.set?.saving_at_own_ceiling_pct_30d).toBe(e.properties.saving_at_own_ceiling_pct_30d)
  })

  it('sans plafond réglé, le gain au plafond propre est null — pas zéro', () => {
    saveClaudeSettings({})
    const e = buildSavingsSnapshot('gain', now)
    expect(e.properties.autocompact_window).toBeNull()
    // null, never 0: "no ceiling" and "a ceiling worth nothing" must stay apart
    expect(e.properties.saving_at_own_ceiling_pct_30d).toBeNull()
    expect(e.properties.autocompact_ceiling_inert).toBeNull()
  })

  it('reste sain sans aucune donnée locale', () => {
    fs.unlinkSync(STATS_FILE)
    const e = buildSavingsSnapshot('install', now)
    expect(e.properties).toMatchObject({ sessions: 0, requests: 0, saved_tokens: 0, saved_pct: 0, top_model: 'unknown' })
  })
})

describe('snapshotDue', () => {
  it('télémétrie off → jamais ; on → une fois par 24 h, sauf force', () => {
    saveConfig({ telemetry: false })
    expect(snapshotDue(now)).toBe(false)
    expect(snapshotDue(now, true)).toBe(false)
    saveConfig({ telemetry: true })
    expect(snapshotDue(now)).toBe(true)
    saveConfig({ telemetry: true, lastSnapshotAt: new Date(now.getTime() - SNAPSHOT_INTERVAL_MS + 60_000).toISOString() })
    expect(snapshotDue(now)).toBe(false)
    expect(snapshotDue(now, true)).toBe(true)
    saveConfig({ telemetry: true, lastSnapshotAt: new Date(now.getTime() - SNAPSHOT_INTERVAL_MS).toISOString() })
    expect(snapshotDue(now)).toBe(true)
  })
})
