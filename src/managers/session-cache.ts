/**
 * Session Cache — snapshot de projet inter-sessions.
 * Estimated gain: 40–60% of input tokens on subsequent sessions.
 *
 * Saves an ultra-compressed project snapshot at the end of a session.
 * La session suivante charge ce snapshot comme contexte initial.
 */

import { createHash } from 'crypto'
import fs from 'fs'
import path from 'path'
import type { Message, TextBlock } from '../types/index.js'

interface ProjectSnapshot {
  version: string
  projectHash: string
  projectPath: string
  createdAt: string
  decisions: string[]
  errors: string[]
  conventions: string[]
  keyFiles: FileSignature[]
  summary: string
}

interface FileSignature {
  path: string
  signatures: string[]
  role: string
}

const SNAPSHOT_VERSION = '1'
const CACHE_DIR = '.cork-ai/cache'

// Patterns to extract decisions
const DECISION_PATTERNS = [
  /(?:on garde|c'est décidé|la règle est|il est décidé|on a choisi|we decided|final decision|the rule is)(.{0,200})/gi,
  /(?:convention|standard|pattern):\s*(.{0,150})/gi,
]

// Patterns pour extraire les erreurs et leurs solutions
const ERROR_SOLUTION_PATTERNS = [
  /(?:Error|Exception|FAIL):\s*(.{0,100})[\s\S]{0,50}(?:fixed|solved|resolved|corrigé|solution):\s*(.{0,150})/gi,
  /(?:le bug venait de|root cause|caused by)(.{0,150})/gi,
]

// Patterns pour les conventions de code
const CONVENTION_PATTERNS = [
  /(?:naming convention|on utilise|we use|convention de nommage):\s*(.{0,150})/gi,
  /(?:pattern|style|format):\s*(.{0,100})/gi,
]

/**
 * Computes the project hash based on its absolute path.
 */
function computeProjectHash(projectPath: string): string {
  const normalized = path.resolve(projectPath).toLowerCase()
  return createHash('sha1').update(normalized).digest('hex').slice(0, 12)
}

/**
 * Extrait le texte des messages.
 */
function extractAllText(messages: Message[]): string {
  return messages
    .map(m => {
      if (typeof m.content === 'string') return m.content
      return m.content
        .filter((b): b is TextBlock => b.type === 'text')
        .map(b => b.text)
        .join('\n')
    })
    .join('\n')
}

/**
 * Extracts decisions made during the session.
 */
function extractDecisions(text: string): string[] {
  const decisions: Set<string> = new Set()
  for (const pattern of DECISION_PATTERNS) {
    pattern.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = pattern.exec(text)) !== null) {
      const decision = m[1].trim().slice(0, 150)
      if (decision.length > 10) decisions.add(decision)
    }
  }
  return Array.from(decisions).slice(0, 10)
}

/**
 * Extracts errors encountered and solutions applied.
 */
function extractErrors(text: string): string[] {
  const errors: Set<string> = new Set()
  for (const pattern of ERROR_SOLUTION_PATTERNS) {
    pattern.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = pattern.exec(text)) !== null) {
      const error = m[0].trim().slice(0, 200)
      if (error.length > 10) errors.add(error)
    }
  }
  return Array.from(errors).slice(0, 8)
}

/**
 * Extracts detected code conventions.
 */
function extractConventions(text: string): string[] {
  const conventions: Set<string> = new Set()
  for (const pattern of CONVENTION_PATTERNS) {
    pattern.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = pattern.exec(text)) !== null) {
      const conv = m[1].trim().slice(0, 100)
      if (conv.length > 5) conventions.add(conv)
    }
  }
  return Array.from(conventions).slice(0, 8)
}

/**
 * Extracts signatures of key files mentioned in the conversation.
 */
function extractKeyFiles(messages: Message[]): FileSignature[] {
  const fileMap = new Map<string, string[]>()

  for (const msg of messages) {
    if (typeof msg.content === 'string') continue
    for (const block of msg.content) {
      if (block.type === 'tool_use' && ['Write', 'write', 'create_file', 'str_replace_editor'].includes(block.name)) {
        const input = block.input
        const filePath = (
          (typeof input['path'] === 'string' && input['path']) ||
          (typeof input['file_path'] === 'string' && input['file_path']) ||
          ''
        )
        const content = (
          (typeof input['content'] === 'string' && input['content']) ||
          (typeof input['new_str'] === 'string' && input['new_str']) ||
          ''
        )
        if (filePath && content) {
          const signatures = extractCodeSignatures(content)
          if (signatures.length > 0) {
            fileMap.set(filePath, signatures)
          }
        }
      }
    }
  }

  return Array.from(fileMap.entries())
    .slice(0, 15)
    .map(([filePath, signatures]) => ({
      path: filePath,
      signatures: signatures.slice(0, 8),
      role: inferFileRole(filePath),
    }))
}

/**
 * Extrait les signatures (imports + exports + fonctions) d'un fichier de code.
 */
function extractCodeSignatures(content: string): string[] {
  const signatures: string[] = []
  const lines = content.split('\n')
  const signaturePattern = /^(import|export|function|class|interface|type|const|let|var|def |fn |pub fn )\s+\w+/

  for (const line of lines) {
    if (signaturePattern.test(line.trim())) {
      signatures.push(line.trim().slice(0, 80))
    }
  }
  return signatures
}

/**
 * Infers the role of a file from its path.
 */
function inferFileRole(filePath: string): string {
  const name = path.basename(filePath).toLowerCase()
  if (name.includes('index')) return 'entry point'
  if (name.includes('test') || name.includes('spec')) return 'tests'
  if (name.includes('config')) return 'configuration'
  if (name.includes('router') || name.includes('route')) return 'routage'
  if (name.includes('model') || name.includes('schema')) return 'data model'
  if (name.includes('service')) return 'service'
  if (name.includes('util') || name.includes('helper')) return 'utilitaires'
  return 'source'
}

/**
 * Serializes the snapshot into compact text for injection into the system prompt.
 */
function snapshotToText(snapshot: ProjectSnapshot): string {
  const parts: string[] = [
    `## Project context (previous session — ${snapshot.createdAt})`,
  ]

  if (snapshot.decisions.length > 0) {
    parts.push('\n### Technical decisions')
    snapshot.decisions.forEach(d => parts.push(`- ${d}`))
  }

  if (snapshot.errors.length > 0) {
    parts.push('\n### Errors and solutions')
    snapshot.errors.forEach(e => parts.push(`- ${e}`))
  }

  if (snapshot.conventions.length > 0) {
    parts.push('\n### Detected conventions')
    snapshot.conventions.forEach(c => parts.push(`- ${c}`))
  }

  if (snapshot.keyFiles.length > 0) {
    parts.push('\n### Key project files')
    for (const file of snapshot.keyFiles) {
      parts.push(`\n**${file.path}** (${file.role})`)
      file.signatures.forEach(s => parts.push(`  ${s}`))
    }
  }

  if (snapshot.summary) {
    parts.push(`\n### Session summary\n${snapshot.summary}`)
  }

  return parts.join('\n')
}

/**
 * Sauvegarde un snapshot de la session dans le cache projet.
 * @param messages - Historique complet de la session
 * @param projectPath - Chemin racine du projet
 */
export function saveSession(messages: Message[], projectPath: string): void {
  const allText = extractAllText(messages)
  const projectHash = computeProjectHash(projectPath)

  const snapshot: ProjectSnapshot = {
    version: SNAPSHOT_VERSION,
    projectHash,
    projectPath: path.resolve(projectPath),
    createdAt: new Date().toISOString(),
    decisions: extractDecisions(allText),
    errors: extractErrors(allText),
    conventions: extractConventions(allText),
    keyFiles: extractKeyFiles(messages),
    summary: allText.split(/\s+/).slice(0, 80).join(' ') + '...',
  }

  const cacheDir = path.join(projectPath, CACHE_DIR)
  fs.mkdirSync(cacheDir, { recursive: true })

  const cachePath = path.join(cacheDir, `${projectHash}.json`)
  fs.writeFileSync(cachePath, JSON.stringify(snapshot, null, 2), 'utf-8')
}

/**
 * Loads the snapshot from the previous session for a project.
 * @param projectPath - Chemin racine du projet
 * @returns Compact snapshot text to inject into the system prompt, or null
 */
export function loadSession(projectPath: string): string | null {
  const projectHash = computeProjectHash(projectPath)
  const cachePath = path.join(projectPath, CACHE_DIR, `${projectHash}.json`)

  try {
    const data = fs.readFileSync(cachePath, 'utf-8')
    const snapshot = JSON.parse(data) as ProjectSnapshot
    if (snapshot.version !== SNAPSHOT_VERSION) return null
    return snapshotToText(snapshot)
  } catch {
    return null
  }
}

/**
 * Public class for advanced use.
 */
export class SessionCache {
  save(messages: Message[], projectPath: string): void {
    saveSession(messages, projectPath)
  }

  load(projectPath: string): string | null {
    return loadSession(projectPath)
  }
}
