/**
 * Dynamic System Prompt — injection sélective des sections du system prompt.
 * Gain estimé : 10–20% des tokens input sur les gros system prompts.
 *
 * Les sections sont taguées dans le system prompt :
 *   <!-- @cork-ai section: python -->
 *   ... instructions Python ...
 *   <!-- @cork-ai end -->
 *
 * Seules les sections pertinentes pour le contexte actif sont injectées.
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

// Triggers par défaut par type de section
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
 * Parse un system prompt segmenté en sections.
 */
function parseSystemPrompt(systemPrompt: string): ParsedSystemPrompt {
  const sections: SectionDefinition[] = []

  // Trouver toutes les sections taguées
  const openPattern = /<!--\s*@cork-ai\s+section:\s*(\S+)(?:\s+triggers:\s*([^>]*))?\s*-->([\s\S]*?)<!--\s*@cork-ai\s+end\s*-->/g
  let match: RegExpExecArray | null

  const sectionPositions: Array<{ start: number; end: number; name: string; triggers: string[]; content: string }> = []

  while ((match = openPattern.exec(systemPrompt)) !== null) {
    const name = match[1].trim()
    const triggersRaw = match[2] ? match[2].trim() : ''
    const content = match[3].trim()

    // Parser les triggers : liste séparée par virgules ou espaces
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

  // Le core est tout ce qui n'est pas dans une section taguée
  let core = systemPrompt
  // Supprimer les sections en sens inverse
  for (const pos of [...sectionPositions].reverse()) {
    core = core.slice(0, pos.start) + core.slice(pos.end)
  }
  core = core.replace(/\n{3,}/g, '\n\n').trim()

  return { core, sections }
}

/**
 * Extrait le texte des N derniers messages pour détecter le contexte actif.
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
 * Détermine quelles sections activer en fonction du contexte récent.
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
 * Calcule un fingerprint du system prompt pour éviter les recalculs.
 */
function fingerprintPrompt(prompt: string): string {
  return createHash('sha1').update(prompt).digest('hex').slice(0, 12)
}

/**
 * Gestionnaire de system prompt dynamique.
 */
export class DynamicSystemPrompt {
  private parsed: ParsedSystemPrompt | null = null
  private lastFingerprint = ''
  private lastContext = ''
  private lastResult = ''

  /**
   * Construit le system prompt adapté au contexte récent.
   * @param systemPrompt - System prompt brut avec les sections taguées
   * @param recentMessages - Messages récents pour détecter le contexte
   * @returns System prompt optimisé pour le contexte actif
   */
  build(systemPrompt: string, recentMessages: Message[] = []): string {
    const fp = fingerprintPrompt(systemPrompt)
    const context = extractRecentContext(recentMessages)

    // Cache : ne recalculer que si quelque chose a changé
    if (fp === this.lastFingerprint && context === this.lastContext) {
      return this.lastResult
    }

    // Parser si c'est un nouveau system prompt
    if (fp !== this.lastFingerprint) {
      this.parsed = parseSystemPrompt(systemPrompt)
      this.lastFingerprint = fp
    }

    if (!this.parsed) return systemPrompt

    // Si aucune section n'est définie, retourner tel quel
    if (this.parsed.sections.length === 0) {
      this.lastResult = systemPrompt
      this.lastContext = context
      return systemPrompt
    }

    // Sélectionner les sections actives
    const activeSections = selectActiveSections(this.parsed.sections, context)

    // Assembler le prompt final
    const parts = [this.parsed.core]
    for (const section of activeSections) {
      parts.push(`\n<!-- Section: ${section.name} -->\n${section.content}`)
    }

    this.lastResult = parts.join('\n').trim()
    this.lastContext = context
    return this.lastResult
  }

  /**
   * Retourne les tokens économisés pour un appel donné.
   */
  getSavings(systemPrompt: string, recentMessages: Message[]): number {
    const original = countTokens(systemPrompt)
    const optimized = countTokens(this.build(systemPrompt, recentMessages))
    return Math.max(0, original - optimized)
  }
}
