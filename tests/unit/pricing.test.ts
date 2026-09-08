import { describe, expect, it } from 'vitest'
import {
  costOfTokens,
  costOfUsage,
  inputPriceForModel,
  pricingAgeDays,
  PRICING_MAX_AGE_DAYS,
  resolvePricing,
} from '../../src/pricing/index.js'

describe('resolvePricing', () => {
  it('résout Fable 5 à $10/$50', () => {
    const p = resolvePricing('claude-fable-5')
    expect(p.input).toBe(10)
    expect(p.output).toBe(50)
  })

  it('résout Mythos comme Fable', () => {
    expect(resolvePricing('claude-mythos-5').input).toBe(10)
  })

  it('résout Haiku à $1/$5', () => {
    const p = resolvePricing('claude-haiku-4-5')
    expect(p.input).toBe(1)
    expect(p.output).toBe(5)
  })

  it('résout Opus 4.8 à $5/$25', () => {
    const p = resolvePricing('claude-opus-4-8')
    expect(p.input).toBe(5)
    expect(p.output).toBe(25)
  })

  it('résout Opus 5 à $5/$25 (et pas au tarif legacy $15/$75)', () => {
    const p = resolvePricing('claude-opus-5')
    expect(p.input).toBe(5)
    expect(p.output).toBe(25)
  })

  it('résout Opus 4.5 à $5/$25 (la règle opus-5 ne le capture pas)', () => {
    const p = resolvePricing('claude-opus-4-5')
    expect(p.input).toBe(5)
    expect(p.output).toBe(25)
  })

  it('résout Opus legacy (4.1) à $15/$75', () => {
    const p = resolvePricing('claude-opus-4-1')
    expect(p.input).toBe(15)
    expect(p.output).toBe(75)
  })

  it('Sonnet 5 : $2/$10 (tarif intro devenu permanent — la hausse du 2026-09-01 est annulée)', () => {
    const p = resolvePricing('claude-sonnet-5', new Date('2026-12-01'))
    expect(p.input).toBe(2.0)
    expect(p.output).toBe(10.0)
    expect(p.cacheRead).toBeCloseTo(0.2)
  })

  it('Fable 5.1 / Mythos 5.1 : cache read à 0.025× ($0.25/M), les autres paliers comme Fable 5', () => {
    for (const id of ['claude-fable-5-1', 'claude-mythos-5-1']) {
      const p = resolvePricing(id)
      expect(p.input).toBe(10.0)
      expect(p.output).toBe(50.0)
      expect(p.cacheWrite5m).toBeCloseTo(12.5)
      expect(p.cacheWrite1h).toBeCloseTo(20.0)
      expect(p.cacheRead).toBeCloseTo(0.25)
    }
    // Fable 5 keeps the standard 0.1× multiplier
    expect(resolvePricing('claude-fable-5').cacheRead).toBeCloseTo(1.0)
  })

  it('fast mode : usage.speed === "fast" facture Opus 5 à $10/$50, ignoré sur les autres modèles', () => {
    const usage = { input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_input_tokens: 0, speed: 'fast' }
    expect(costOfUsage(usage, 'claude-opus-5')).toBeCloseTo(60)
    expect(costOfUsage({ ...usage, speed: 'standard' }, 'claude-opus-5')).toBeCloseTo(30)
    expect(costOfUsage(usage, 'claude-sonnet-5')).toBeCloseTo(12)
  })

  it('Sonnet 5 : tarif intro $2/$10 avant le 2026-08-31', () => {
    const p = resolvePricing('claude-sonnet-5', new Date('2026-07-15'))
    expect(p.input).toBe(2)
    expect(p.output).toBe(10)
  })


  it('Sonnet 4.6 : $3/$15 sans période intro', () => {
    const p = resolvePricing('claude-sonnet-4-6', new Date('2026-07-15'))
    expect(p.input).toBe(3)
  })

  it('fallback Sonnet quand le modèle est inconnu ou absent', () => {
    expect(resolvePricing(undefined).input).toBe(3)
    expect(resolvePricing('gpt-4').input).toBe(3)
  })

  it('paliers de cache : write 5m = 1.25×, write 1h = 2×, read = 0.1×', () => {
    const p = resolvePricing('claude-opus-4-8')
    expect(p.cacheWrite5m).toBeCloseTo(6.25)
    expect(p.cacheWrite1h).toBeCloseTo(10)
    expect(p.cacheRead).toBeCloseTo(0.5)
  })
})

describe('inputPriceForModel', () => {
  it('retourne le prix input seul', () => {
    expect(inputPriceForModel('claude-opus-4-8')).toBe(5)
    expect(inputPriceForModel()).toBe(3)
  })
})

describe('costOfTokens', () => {
  it('facture 1M tokens input Opus 4.8 à $5', () => {
    expect(costOfTokens(1_000_000, 'input', 'claude-opus-4-8')).toBeCloseTo(5)
  })

  it('facture 1M tokens cache-read Opus 4.8 à $0.50', () => {
    expect(costOfTokens(1_000_000, 'cacheRead', 'claude-opus-4-8')).toBeCloseTo(0.5)
  })
})

describe('costOfUsage', () => {
  it('calcule le coût réel sur les 4 paliers', () => {
    // Opus 4.8: input $5, output $25, cacheWrite5m $6.25, cacheRead $0.50
    const cost = costOfUsage(
      {
        input_tokens: 1_000_000,
        output_tokens: 1_000_000,
        cache_creation_input_tokens: 1_000_000,
        cache_read_input_tokens: 1_000_000,
      },
      'claude-opus-4-8',
    )
    expect(cost).toBeCloseTo(5 + 25 + 6.25 + 0.5)
  })

  it('tolère les champs cache absents', () => {
    const cost = costOfUsage({ input_tokens: 1_000_000, output_tokens: 0 }, 'claude-haiku-4-5')
    expect(cost).toBeCloseTo(1)
  })
})

describe('garde-fou fraîcheur de la table', () => {
  it(`la table de pricing a moins de ${PRICING_MAX_AGE_DAYS} jours — sinon la mettre à jour depuis anthropic.com/pricing et bump PRICING_UPDATED_AT`, () => {
    expect(pricingAgeDays()).toBeLessThan(PRICING_MAX_AGE_DAYS)
  })
})
