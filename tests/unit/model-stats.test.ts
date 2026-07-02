import { describe, it, expect } from 'vitest'
import { getStatsByModel, type GlobalStats, type LiveSession } from '../../src/cli/persistent-stats'

function makeGlobalStats(byModel: GlobalStats['allTime']['byModel']): GlobalStats {
  return {
    version: '1',
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
    allTime: {
      totalRequests: 0,
      totalOriginalTokens: 0,
      totalCompressedTokens: 0,
      totalSavedTokens: 0,
      estimatedCostSaved: 0,
      byModel,
    },
    sessions: [],
  }
}

describe('getStatsByModel', () => {
  it('returns an empty array when there is no data', () => {
    expect(getStatsByModel(null)).toEqual([])
    expect(getStatsByModel(makeGlobalStats({}))).toEqual([])
    expect(getStatsByModel(makeGlobalStats(undefined))).toEqual([])
  })

  it('computes request share across models, sorted by requests', () => {
    const stats = makeGlobalStats({
      'claude-fable-5': { requests: 3, originalTokens: 3000, savedTokens: 1500, costSaved: 0.015, lastUsedAt: '2026-06-02T00:00:00.000Z' },
      'claude-haiku-4-5': { requests: 1, originalTokens: 500, savedTokens: 200, costSaved: 0.0002, lastUsedAt: '2026-06-01T00:00:00.000Z' },
    })
    const result = getStatsByModel(stats)

    expect(result).toHaveLength(2)
    expect(result[0].model).toBe('claude-fable-5')
    expect(result[0].requestShare).toBeCloseTo(75)
    expect(result[1].model).toBe('claude-haiku-4-5')
    expect(result[1].requestShare).toBeCloseTo(25)
  })

  it('merges the live session into all-time totals', () => {
    const stats = makeGlobalStats({
      'claude-fable-5': { requests: 2, originalTokens: 2000, savedTokens: 1000, costSaved: 0.01, lastUsedAt: '2026-06-02T00:00:00.000Z' },
    })
    const live: LiveSession = {
      sessionId: 'live-1',
      projectPath: '/tmp/p',
      startedAt: '2026-06-03T00:00:00.000Z',
      lastActivityAt: '2026-06-03T00:00:00.000Z',
      requests: 2,
      originalTokens: 1200,
      compressedTokens: 500,
      savedTokens: 700,
      estimatedCostSaved: 0.009,
      byModule: {},
      byModel: {
        'claude-fable-5': { requests: 1, originalTokens: 800, savedTokens: 500, costSaved: 0.005, lastUsedAt: '2026-06-03T00:00:00.000Z' },
        'claude-sonnet-5': { requests: 1, originalTokens: 400, savedTokens: 200, costSaved: 0.0006, lastUsedAt: '2026-06-03T00:00:01.000Z' },
      },
    }

    const result = getStatsByModel(stats, live)

    expect(result).toHaveLength(2)
    const fable = result.find(m => m.model === 'claude-fable-5')!
    expect(fable.requests).toBe(3)
    expect(fable.savedTokens).toBe(1500)
    expect(fable.costSaved).toBeCloseTo(0.015)
    expect(fable.lastUsedAt).toBe('2026-06-03T00:00:00.000Z')
    expect(fable.requestShare).toBeCloseTo(75)

    const sonnet = result.find(m => m.model === 'claude-sonnet-5')!
    expect(sonnet.requests).toBe(1)
    expect(sonnet.requestShare).toBeCloseTo(25)
  })

  it('does not mutate the source stats when merging', () => {
    const usage = { requests: 1, originalTokens: 100, savedTokens: 50, costSaved: 0.0005, lastUsedAt: '2026-06-01T00:00:00.000Z' }
    const stats = makeGlobalStats({ 'claude-fable-5': usage })
    const live: LiveSession = {
      sessionId: 'live-2',
      projectPath: '/tmp/p',
      startedAt: '2026-06-03T00:00:00.000Z',
      lastActivityAt: '2026-06-03T00:00:00.000Z',
      requests: 1,
      originalTokens: 100,
      compressedTokens: 50,
      savedTokens: 50,
      estimatedCostSaved: 0.0005,
      byModule: {},
      byModel: { 'claude-fable-5': { ...usage } },
    }

    getStatsByModel(stats, live)
    expect(stats.allTime.byModel!['claude-fable-5'].requests).toBe(1)
    expect(live.byModel!['claude-fable-5'].requests).toBe(1)
  })
})
