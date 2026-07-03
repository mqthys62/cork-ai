/**
 * Shared types for cork-ai.
 * All public and internal interfaces go through this module.
 */

// ─── Message types (Anthropic SDK-compatible) ────────────────────────────────────

export type MessageRole = 'user' | 'assistant'

export interface TextBlock {
  type: 'text'
  text: string
}

export interface ToolUseBlock {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, unknown>
}

export interface ToolResultBlock {
  type: 'tool_result'
  tool_use_id: string
  content: string | ContentBlock[]
}

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock

export interface Message {
  role: MessageRole
  content: string | ContentBlock[]
}

// ─── Stats ───────────────────────────────────────────────────────────────────

export interface ModuleStats {
  /** Module name */
  name: string
  /** Tokens saved by this module */
  saved: number
  /** Number of times the module has run */
  runs: number
}

export interface RequestStats {
  originalTokens: number
  compressedTokens: number
  savedTokens: number
  savingsPercent: number
  /** Estimated cost saved in USD (cache-aware when the breakdown is known) */
  estimatedCostSaved: number
  /** Tokens saved on newly-compressed content this request (billed at input rate) */
  newlySavedTokens?: number
  /** Tokens saved on previously-frozen content (billed at cache-read rate) */
  frozenSavedTokens?: number
}

/** Real usage measured from the API's `response.usage` — ground truth. */
export interface MeasuredUsageStats {
  requests: number
  inputTokens: number
  outputTokens: number
  cacheCreationInputTokens: number
  cacheReadInputTokens: number
  /** Real cost in USD across the four billing tiers */
  costUSD: number
}

export interface SessionStats {
  totalSaved: number
  totalProcessed: number
  /** Cumulative cost saved in USD */
  estimatedCostSaved: number
  requestCount: number
  /** Ground-truth usage from the API, when available (wrapClient path) */
  measured?: MeasuredUsageStats
}

export interface FullStats {
  request: RequestStats
  session: SessionStats
  byModule: Record<string, { saved: number; runs: number }>
}

// ─── Configuration ────────────────────────────────────────────────────────────

export interface PricingConfig {
  /** USD per million input tokens */
  input: number
  /** USD per million output tokens */
  output: number
}

export interface ToolResultOptions {
  /** 0.0 = conservative, 1.0 = aggressive */
  aggressiveness: number
  /** Max lines to keep for a code file */
  maxCodeLines: number
  /** Max lines to keep for bash output */
  maxBashLines: number
  /** Enable side-channel cache for restore() */
  cacheEnabled: boolean
}

export interface CodeDedupOptions {
  aggressiveness: number
}

export interface HeaderStripperOptions {
  aggressiveness: number
}

export interface HeatmapOptions {
  /** Window of recent messages for relevance scoring */
  windowSize: number
  /** Score threshold below which a message is summarized (0–1) */
  threshold: number
}

export interface SemanticDedupOptions {
  /** Jaccard similarity threshold (default 0.82) */
  similarityThreshold: number
}

export interface BudgetConfig {
  /** Max tokens in context */
  maxTokens: number
  /** If true: throw if context exceeds maxTokens even after compression */
  hardLimit: boolean
}

export interface SoftThrottleOptions {
  /** Enable soft throttling based on anthropic-ratelimit-* headers */
  enabled: boolean
  /** Remaining/limit ratio below which requests are delayed (default 0.1 = 10%) */
  thresholdPct?: number
  /** Maximum delay applied to a single request in ms (default 5000) */
  maxDelayMs?: number
}

export interface CorkAIOptions {
  /** Global aggressiveness level (0.0–1.0, default 0.6) */
  aggressiveness?: number
  /** Max token budget for context */
  maxContextTokens?: number
  /** Budget configuration */
  budget?: Partial<BudgetConfig>
  /** Pricing for cost estimation (overrides per-model auto-detection) */
  pricing?: Partial<PricingConfig>
  /** Enable debug logs */
  debug?: boolean
  /** Callback invoked after each compression */
  onStats?: (stats: FullStats) => void
  /** Modules to explicitly disable */
  disabledModules?: ModuleName[]
  /**
   * Prefix-stable compression (default true in wrapClient): compression
   * decisions on old messages are frozen byte-identical across requests so
   * the Anthropic prompt cache prefix stays valid. Disabling it re-scores
   * the whole history on every request — cheaper-looking token counts, but
   * every request pays full input price instead of 0.1× cache reads.
   */
  prefixStable?: boolean
  /** Delay requests when rate-limit headers show quota running out */
  softThrottle?: SoftThrottleOptions
}

export type ModuleName =
  | 'toolResultCompressor'
  | 'codeDedup'
  | 'headerStripper'
  | 'heatmap'
  | 'semanticDedup'
  | 'selectiveSummarizer'
  | 'systemPrompt'
  | 'sessionCache'

// ─── Compression results ──────────────────────────────────────────────────────

export interface CompressResult {
  messages: Message[]
  /** Tokens saved by this module */
  savedTokens: number
  /** Optional details */
  details?: string
}

// ─── Heatmap ──────────────────────────────────────────────────────────────────

export interface HeatmapScore {
  messageIndex: number
  score: number
  reason: string
}

// ─── Rate limits ──────────────────────────────────────────────────────────────

/** Parsed from anthropic-ratelimit-* response headers. */
export interface RateLimitStatus {
  requestsLimit?: number
  requestsRemaining?: number
  requestsReset?: string
  inputTokensLimit?: number
  inputTokensRemaining?: number
  inputTokensReset?: string
  outputTokensLimit?: number
  outputTokensRemaining?: number
  outputTokensReset?: string
  tokensLimit?: number
  tokensRemaining?: number
  tokensReset?: string
  /** Last time the headers were observed */
  observedAt?: string
}

// ─── Cache side-channel ────────────────────────────────────────────────────────

export interface CachedContent {
  refId: string
  originalContent: string
  compressedPlaceholder: string
  contentType: 'code' | 'bash' | 'json' | 'text'
  createdAt: number
}
