/**
 * Pricing — single source of truth for Claude model pricing.
 * Used by both the library (StatsTracker, interceptor) and the CLI.
 *
 * Covers all four billing tiers:
 *   - input (uncached prompt tokens)          → 1× base input price
 *   - cache write, 5-minute TTL               → 1.25× base input price
 *   - cache write, 1-hour TTL                 → 2× base input price
 *   - cache read                              → 0.1× base input price
 *   - output                                  → separate output price
 *
 * Pricing source: anthropic.com/pricing
 */

/** Date the table below was last verified against anthropic.com/pricing. */
export const PRICING_UPDATED_AT = '2026-07-02'

/** Warn/fail threshold: pricing tables older than this are considered stale. */
export const PRICING_MAX_AGE_DAYS = 183

export interface ModelPricing {
  /** USD per million uncached input tokens */
  input: number
  /** USD per million output tokens */
  output: number
  /** USD per million tokens written to the 5-minute cache (1.25× input) */
  cacheWrite5m: number
  /** USD per million tokens written to the 1-hour cache (2× input) */
  cacheWrite1h: number
  /** USD per million tokens served from cache (0.1× input) */
  cacheRead: number
}

/** Anthropic's cache multipliers are uniform across models. */
function mk(input: number, output: number): ModelPricing {
  return {
    input,
    output,
    cacheWrite5m: input * 1.25,
    cacheWrite1h: input * 2,
    cacheRead: input * 0.1,
  }
}

interface PricingRule {
  pattern: RegExp
  base: ModelPricing
  /** Date-bounded overrides (e.g. introductory pricing). First match wins. */
  periods?: Array<{ until: string; pricing: ModelPricing }>
}

// First matching pattern wins — keep specific patterns before generic ones.
const RULES: PricingRule[] = [
  { pattern: /fable|mythos/i, base: mk(10.0, 50.0) },
  { pattern: /haiku/i, base: mk(1.0, 5.0) },
  {
    // Sonnet 5 — introductory pricing $2/$10 through 2026-08-31, then $3/$15
    pattern: /sonnet-5/i,
    base: mk(3.0, 15.0),
    periods: [{ until: '2026-08-31', pricing: mk(2.0, 10.0) }],
  },
  { pattern: /sonnet/i, base: mk(3.0, 15.0) },
  // Opus 5 and later ("claude-opus-5", "claude-opus-6", …). Must come before
  // the opus-4 rule: "opus-[5-9]" cannot match "opus-4-5" (the char after the
  // first hyphen is "4"), so the two rules are disjoint.
  { pattern: /opus-[5-9]/i, base: mk(5.0, 25.0) },
  { pattern: /opus-4-[5-9]/i, base: mk(5.0, 25.0) },
  // Legacy Opus (3, 4.0, 4.1) — the only models still on $15/$75.
  { pattern: /opus/i, base: mk(15.0, 75.0) },
]

/** Fallback when no model is known: Sonnet pricing (the most common default). */
export const FALLBACK_PRICING: ModelPricing = mk(3.0, 15.0)

/**
 * Resolves the full pricing for a model at a given date.
 * @param modelId - Claude model ID (e.g. "claude-sonnet-5", "claude-opus-4-8")
 * @param date - Date of the request (introductory pricing is date-dependent)
 */
export function resolvePricing(modelId?: string, date: Date = new Date()): ModelPricing {
  if (!modelId) return FALLBACK_PRICING
  const rule = RULES.find(r => r.pattern.test(modelId))
  if (!rule) return FALLBACK_PRICING
  if (rule.periods) {
    const iso = date.toISOString().slice(0, 10)
    for (const period of rule.periods) {
      if (iso <= period.until) return period.pricing
    }
  }
  return rule.base
}

/** USD per million uncached input tokens for a model. */
export function inputPriceForModel(modelId?: string, date?: Date): number {
  return resolvePricing(modelId, date).input
}

// ─── Cost helpers ─────────────────────────────────────────────────────────────

export type BillingTier = 'input' | 'output' | 'cacheWrite5m' | 'cacheWrite1h' | 'cacheRead'

/** Cost in USD of `tokens` tokens billed at the given tier for the given model. */
export function costOfTokens(
  tokens: number,
  tier: BillingTier,
  modelId?: string,
  date?: Date,
): number {
  const pricing = resolvePricing(modelId, date)
  return (tokens / 1_000_000) * pricing[tier]
}

/** Shape of the `usage` object returned by the Anthropic API. */
export interface ApiUsage {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
  /**
   * Per-TTL breakdown of cache writes, when the API reports it. The 1-hour
   * tier bills at 2× input against 1.25× for the 5-minute tier — a 60%
   * difference, so use this split whenever it is present.
   */
  cache_creation?: {
    ephemeral_5m_input_tokens?: number
    ephemeral_1h_input_tokens?: number
  }
}

/**
 * Real cost in USD of a request, from the API's own `usage` object.
 *
 * Cache writes are billed per TTL when `usage.cache_creation` carries the
 * split; otherwise the flat `cache_creation_input_tokens` field is assumed to
 * be 5-minute writes (an underestimate for any 1-hour cache).
 */
export function costOfUsage(usage: ApiUsage, modelId?: string, date?: Date): number {
  const p = resolvePricing(modelId, date)

  const split = usage.cache_creation
  const write5m = split?.ephemeral_5m_input_tokens
  const write1h = split?.ephemeral_1h_input_tokens
  const hasSplit = write5m !== undefined || write1h !== undefined

  const cacheWriteCost = hasSplit
    ? ((write5m ?? 0) / 1_000_000) * p.cacheWrite5m +
      ((write1h ?? 0) / 1_000_000) * p.cacheWrite1h
    : ((usage.cache_creation_input_tokens ?? 0) / 1_000_000) * p.cacheWrite5m

  return (
    (usage.input_tokens / 1_000_000) * p.input +
    (usage.output_tokens / 1_000_000) * p.output +
    cacheWriteCost +
    ((usage.cache_read_input_tokens ?? 0) / 1_000_000) * p.cacheRead
  )
}

/** Age of the pricing table in days — used by the staleness guard test. */
export function pricingAgeDays(now: Date = new Date()): number {
  const updated = new Date(PRICING_UPDATED_AT + 'T00:00:00Z')
  return Math.floor((now.getTime() - updated.getTime()) / 86_400_000)
}
