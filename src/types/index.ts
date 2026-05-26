/**
 * Types partagés pour cork-ai.
 * Toutes les interfaces publiques et internes passent par ce module.
 */

// ─── Types de messages (compatibles Anthropic SDK) ───────────────────────────

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
  /** Nom du module */
  name: string
  /** Tokens économisés par ce module */
  saved: number
  /** Nombre de fois que le module a été exécuté */
  runs: number
}

export interface RequestStats {
  originalTokens: number
  compressedTokens: number
  savedTokens: number
  savingsPercent: number
  /** Coût économisé estimé en USD */
  estimatedCostSaved: number
}

export interface SessionStats {
  totalSaved: number
  totalProcessed: number
  /** Coût économisé cumulé en USD */
  estimatedCostSaved: number
  requestCount: number
}

export interface FullStats {
  request: RequestStats
  session: SessionStats
  byModule: Record<string, { saved: number; runs: number }>
}

// ─── Configuration ────────────────────────────────────────────────────────────

export interface PricingConfig {
  /** USD par million de tokens en input */
  input: number
  /** USD par million de tokens en output */
  output: number
}

export interface ToolResultOptions {
  /** 0.0 = conservateur, 1.0 = agressif */
  aggressiveness: number
  /** Nombre max de lignes à conserver pour un fichier de code */
  maxCodeLines: number
  /** Nombre max de lignes à conserver pour une sortie bash */
  maxBashLines: number
  /** Activer le cache side-channel pour restore() */
  cacheEnabled: boolean
}

export interface CodeDedupOptions {
  aggressiveness: number
}

export interface HeaderStripperOptions {
  aggressiveness: number
}

export interface HeatmapOptions {
  /** Fenêtre de messages récents pour le calcul de pertinence */
  windowSize: number
  /** Seuil de score en dessous duquel un message est résumé (0–1) */
  threshold: number
}

export interface SemanticDedupOptions {
  /** Seuil de similarité Jaccard (défaut 0.82) */
  similarityThreshold: number
}

export interface BudgetConfig {
  /** Nombre max de tokens dans le contexte */
  maxTokens: number
  /** Si true : throw si le contexte dépasse maxTokens même après compression */
  hardLimit: boolean
}

export interface CorkAIOptions {
  /** Niveau d'aggressivité global (0.0–1.0, défaut 0.6) */
  aggressiveness?: number
  /** Budget tokens max du contexte */
  maxContextTokens?: number
  /** Configuration du budget */
  budget?: Partial<BudgetConfig>
  /** Pricing pour l'estimation des coûts */
  pricing?: Partial<PricingConfig>
  /** Activer les logs de debug */
  debug?: boolean
  /** Callback appelé après chaque compression */
  onStats?: (stats: FullStats) => void
  /** Modules à désactiver explicitement */
  disabledModules?: ModuleName[]
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

// ─── Résultats de compression ─────────────────────────────────────────────────

export interface CompressResult {
  messages: Message[]
  /** Tokens économisés par ce module */
  savedTokens: number
  /** Détails optionnels */
  details?: string
}

// ─── Heatmap ──────────────────────────────────────────────────────────────────

export interface HeatmapScore {
  messageIndex: number
  score: number
  reason: string
}

// ─── Cache side-channel ────────────────────────────────────────────────────────

export interface CachedContent {
  refId: string
  originalContent: string
  compressedPlaceholder: string
  contentType: 'code' | 'bash' | 'json' | 'text'
  createdAt: number
}
