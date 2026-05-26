import { describe, it, expect, beforeEach } from 'vitest'
import { StatsTracker } from '../../src/stats/tracker.js'

describe('StatsTracker', () => {
  let tracker: StatsTracker

  beforeEach(() => {
    tracker = new StatsTracker()
  })

  describe('recordModule', () => {
    it('enregistre les tokens économisés pour un module', () => {
      tracker.recordModule('toolResultCompressor', 500)
      const stats = tracker.getFullStats(1000, 500)
      expect(stats.byModule['toolResultCompressor']).toBeDefined()
      expect(stats.byModule['toolResultCompressor'].saved).toBe(500)
      expect(stats.byModule['toolResultCompressor'].runs).toBe(1)
    })

    it('accumule les runs pour le même module', () => {
      tracker.recordModule('headerStripper', 100)
      tracker.recordModule('headerStripper', 150)
      const stats = tracker.getFullStats(1000, 750)
      expect(stats.byModule['headerStripper'].saved).toBe(250)
      expect(stats.byModule['headerStripper'].runs).toBe(2)
    })

    it('gère plusieurs modules indépendants', () => {
      tracker.recordModule('toolResultCompressor', 500)
      tracker.recordModule('headerStripper', 100)
      tracker.recordModule('codeDedup', 200)
      const stats = tracker.getFullStats(2000, 1200)
      expect(Object.keys(stats.byModule)).toHaveLength(3)
    })
  })

  describe('getRequestStats', () => {
    it('calcule correctement les tokens économisés', () => {
      const stats = tracker.getRequestStats(1000, 600)
      expect(stats.originalTokens).toBe(1000)
      expect(stats.compressedTokens).toBe(600)
      expect(stats.savedTokens).toBe(400)
      expect(stats.savingsPercent).toBe(40)
    })

    it('calcule le pourcentage d\'économie', () => {
      const stats = tracker.getRequestStats(10000, 3000)
      expect(stats.savingsPercent).toBe(70)
    })

    it('gère le cas où originalTokens = 0', () => {
      const stats = tracker.getRequestStats(0, 0)
      expect(stats.savingsPercent).toBe(0)
      expect(stats.savedTokens).toBe(0)
    })

    it('ne retourne pas de savedTokens négatifs', () => {
      const stats = tracker.getRequestStats(100, 200)
      expect(stats.savedTokens).toBe(0)
    })

    it('calcule un coût estimé positif', () => {
      const stats = tracker.getRequestStats(1_000_000, 300_000)
      expect(stats.estimatedCostSaved).toBeGreaterThan(0)
    })
  })

  describe('getSessionStats', () => {
    it('cumule les stats de plusieurs requêtes', () => {
      tracker.getRequestStats(1000, 600)
      tracker.getRequestStats(2000, 1000)
      const session = tracker.getSessionStats()
      expect(session.requestCount).toBe(2)
      expect(session.totalSaved).toBe(400 + 1000)
      expect(session.totalProcessed).toBe(3000)
    })

    it('commence à zéro', () => {
      const session = tracker.getSessionStats()
      expect(session.requestCount).toBe(0)
      expect(session.totalSaved).toBe(0)
    })
  })

  describe('reset', () => {
    it('remet tout à zéro', () => {
      tracker.recordModule('toolResultCompressor', 500)
      tracker.getRequestStats(1000, 500)
      tracker.reset()

      const stats = tracker.getFullStats(0, 0)
      expect(stats.session.requestCount).toBe(1) // getFullStats compte aussi
      expect(Object.keys(stats.byModule)).toHaveLength(0)
    })
  })

  describe('pricing custom', () => {
    it('utilise le pricing personnalisé', () => {
      const customTracker = new StatsTracker({ input: 15.0, output: 75.0 })
      const stats = customTracker.getRequestStats(1_000_000, 0)
      expect(stats.estimatedCostSaved).toBeCloseTo(15.0, 1)
    })
  })
})
