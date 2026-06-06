/**
 * Dynamic System Prompt — selective injection of system prompt sections.
 * Estimated gain: 10–20% of input tokens on large system prompts.
 *
 * Sections are tagged in the system prompt:
 *   <!-- @cork-ai section: python -->
 *   ... instructions Python ...
 *   <!-- @cork-ai end -->
 *
 * Only sections relevant to the active context are injected.
 */

import { createHash } from 'crypto'
import { countTokens } from '../core/tokenizer.js'
import type { Message } from '../types/index.js'

interface SectionDefinition {
  name: string
  content: string
  triggers: string[]
  isCore: boolean
}

interface ParsedSystemPrompt {
  core: string
  sections: SectionDefinition[]
}

// Default triggers per section type
const DEFAULT_TRIGGERS: Record<string, string[]> = {
  python: ['python', '.py', 'pip', 'django', 'flask', 'fastapi', 'pytest', 'pandas', 'numpy'],
  javascript: ['javascript', '.js', '.jsx', 'node', 'npm', 'webpack', 'eslint'],
  typescript: ['typescript', '.ts', '.tsx', 'tsc', 'tsconfig'],
  rust: ['rust', '.rs', 'cargo', 'crate', 'rustc'],
  go: ['golang', '.go', 'go mod', 'goroutine'],
  git: ['git', 'commit', 'branch', 'merge', 'rebase', 'pull request'],
  docker: ['docker', 'dockerfile', 'container', 'compose', 'kubernetes'],
  sql: ['sql', 'database', 'mysql', 'postgres', 'sqlite', 'query', 'migration'],
  test: ['test', 'spec', 'jest', 'vitest', 'mocha', 'cypress', 'playwright'],
}

/**
 * Parses a segmented system prompt into sections.
 */
function parseSystemPrompt(systemPrompt: string): ParsedSystemPrompt {
  const sections: SectionDefinition[] = []

  // Find all tagged sections
  const openPattern = /<!--\s*@cork-ai\s+section:\s*(\S+)(?:\s+triggers:\s*([^>]*))?\s*-->([\s\S]*?)<!--\s*@cork-ai\s+end\s*-->/g
  let match: RegExpExecArray | null

  const sectionPositions: Array<{ start: number; end: number; name: string; triggers: string[]; content: string }> = []

  while ((match = openPattern.exec(systemPrompt)) !== null) {
    const name = match[1].trim()
    const triggersRaw = match[2] ? match[2].trim() : ''
    const content = match[3].trim()

    // Parse triggers: comma- or space-separated list
    let triggers: string[] = triggersRaw
      ? triggersRaw.split(/[,\s]+/).map(t => t.trim()).filter(Boolean)
      : (DEFAULT_TRIGGERS[name] ?? [name])

    sectionPositions.push({
      start: match.index,
      end: match.index + match[0].length,
      name,
      triggers,
      content,
    })

    sections.push({ name, content, triggers, isCore: false })
  }

  // Core is everything not in a tagged section
  let core = systemPrompt
  // Remove sections in reverse order
  for (const pos of [...sectionPositions].reverse()) {
    core = core.slice(0, pos.start) + core.slice(pos.end)
  }
  core = core.replace(/\n{3,}/g, '\n\n').trim()

  return { core, sections }
}

/**
 * Extracts text from the last N messages to detect the active context.
 */
function extractRecentContext(messages: Message[], windowSize = 5): string {
  const recent = messages.slice(-windowSize)
  return recent
    .map(m => {
      if (typeof m.content === 'string') return m.content
      return m.content
        .filter(b => b.type === 'text')
        .map(b => (b as { type: 'text'; text: string }).text)
        .join('\n')
    })
    .join('\n')
}

/**
 * Determines which sections to activate based on recent context.
 */
function selectActiveSections(
  sections: SectionDefinition[],
  context: string,
): SectionDefinition[] {
  const contextLower = context.toLowerCase()
  return sections.filter(section => {
    return section.isCore || section.triggers.some(trigger =>
      contextLower.includes(trigger.toLowerCase())
    )
  })
}

/**
 * Computes a fingerprint of the system prompt to avoid recomputation.
 */
function fingerprintPrompt(prompt: string): string {
  return createHash('sha1').update(prompt).digest('hex').slice(0, 12)
}

/**
 * Dynamic system prompt manager.
 */
export class DynamicSystemPrompt {
  private parsed: ParsedSystemPrompt | null = null
  private lastFingerprint = ''
  private lastContext = ''
  private lastResult = ''

  /**
   * Builds the system prompt adapted to the recent context.
   * @param systemPrompt - Raw system prompt with tagged sections
   * @param recentMessages - Recent messages to detect the context
   * @returns System prompt optimized for the active context
   */
  build(systemPrompt: string, recentMessages: Message[] = []): string {
    const fp = fingerprintPrompt(systemPrompt)
    const context = extractRecentContext(recentMessages)

    // Cache: only recompute if something changed
    if (fp === this.lastFingerprint && context === this.lastContext) {
      return this.lastResult
    }

    // Parse if it's a new system prompt
    if (fp !== this.lastFingerprint) {
      this.parsed = parseSystemPrompt(systemPrompt)
      this.lastFingerprint = fp
    }

    if (!this.parsed) return systemPrompt

    // If no sections are defined, return as-is
    if (this.parsed.sections.length === 0) {
      this.lastResult = systemPrompt
      this.lastContext = context
      return systemPrompt
    }

    // Select active sections
    const activeSections = selectActiveSections(this.parsed.sections, context)

    // Assemble the final prompt
    const parts = [this.parsed.core]
    for (const section of activeSections) {
      parts.push(`\n<!-- Section: ${section.name} -->\n${section.content}`)
    }

    this.lastResult = parts.join('\n').trim()
    this.lastContext = context
    return this.lastResult
  }

  /**
   * Returns the tokens saved for a given call.
   */
  getSavings(systemPrompt: string, recentMessages: Message[]): number {
    const original = countTokens(systemPrompt)
    const optimized = countTokens(this.build(systemPrompt, recentMessages))
    return Math.max(0, original - optimized)
  }
}
