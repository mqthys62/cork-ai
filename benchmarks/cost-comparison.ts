/**
 * Benchmark cork-ai — mesure réelle des économies de tokens.
 * Exécuter : tsx benchmarks/cost-comparison.ts
 */

import { CtxForge } from '../src/index.js'
import { countMessageTokens } from '../src/core/tokenizer.js'
import type { Message } from '../src/types/index.js'

// ─── Générateur de sessions simulées ─────────────────────────────────────────

function generateSession(
  messageCount: number,
  includeToolResults = true,
  includeHeaders = true,
  includeCodeDuplication = true,
): Message[] {
  const messages: Message[] = []

  for (let i = 0; i < messageCount; i++) {
    if (i % 2 === 0) {
      // Message user
      const parts: string[] = []

      if (includeHeaders) {
        parts.push(`<environment>
CWD: /home/user/projects/my-app
OS: Linux
Platform: WSL2
Open files: src/index.ts, src/utils.ts, src/service.ts
</environment>`)
      }

      if (includeToolResults && i % 4 === 0) {
        // Simuler un tool_result avec un fichier de code volumineux
        messages.push({
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: `tool_${i}`,
              content: generateCodeFile(i),
            },
          ],
        })
        continue
      }

      parts.push(`Message utilisateur #${i} : Comment puis-je améliorer la performance du module ${i % 5} ?`)
      messages.push({ role: 'user', content: parts.join('\n\n') })
    } else {
      // Message assistant
      const codeBlock = includeCodeDuplication && i % 6 === 1
        ? `\n\n\`\`\`typescript\n${generateCodeSnippet(i)}\n\`\`\``
        : ''

      messages.push({
        role: 'assistant',
        content: `Voici mon analyse pour le message #${i}. J'ai examiné le code et identifié plusieurs optimisations possibles. La première consiste à utiliser le memoïzation pour les calculs répétitifs. La seconde est d'optimiser les boucles internes.${codeBlock}`,
      })
    }
  }

  return messages
}

function generateCodeFile(seed: number): string {
  return `// Module généré #${seed}
import { EventEmitter } from 'events'
import { readFileSync, writeFileSync } from 'fs'
import path from 'path'

export interface Config${seed} {
  host: string
  port: number
  timeout: number
  retries: number
  ssl: boolean
}

export class Service${seed} extends EventEmitter {
  private config: Config${seed}
  private cache: Map<string, unknown> = new Map()

  constructor(config: Config${seed}) {
    super()
    this.config = config
  }

  async initialize(): Promise<void> {
    this.emit('init', this.config)
  }

  async process(data: unknown): Promise<unknown> {
    const key = JSON.stringify(data)
    if (this.cache.has(key)) return this.cache.get(key)
    const result = await this.transform(data)
    this.cache.set(key, result)
    return result
  }

  private async transform(data: unknown): Promise<unknown> {
    return JSON.parse(JSON.stringify(data))
  }

  async shutdown(): Promise<void> {
    this.cache.clear()
    this.emit('shutdown')
  }
}
`.repeat(4) // 4x pour simuler un long fichier
}

function generateCodeSnippet(seed: number): string {
  return `export function process${seed}(input: string): string {
  return input.trim().toLowerCase().replace(/\\s+/g, '-')
}

export function validate${seed}(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}`
}

// ─── Benchmark ────────────────────────────────────────────────────────────────

interface BenchmarkResult {
  scenario: string
  messageCount: number
  originalTokens: number
  compressedTokens: number
  savedTokens: number
  savingsPercent: number
  estimatedCostSaved: number
  byModule: Record<string, number>
  durationMs: number
}

async function runBenchmark(
  scenario: string,
  messages: Message[],
  maxContextTokens: number,
): Promise<BenchmarkResult> {
  const forge = new CtxForge({ maxContextTokens, aggressiveness: 0.6 })

  const start = Date.now()
  const { stats } = forge.compress(messages)
  const durationMs = Date.now() - start

  const byModule: Record<string, number> = {}
  for (const [name, data] of Object.entries(stats.byModule)) {
    byModule[name] = data.saved
  }

  return {
    scenario,
    messageCount: messages.length,
    originalTokens: stats.request.originalTokens,
    compressedTokens: stats.request.compressedTokens,
    savedTokens: stats.request.savedTokens,
    savingsPercent: stats.request.savingsPercent,
    estimatedCostSaved: stats.request.estimatedCostSaved,
    byModule,
    durationMs,
  }
}

function printTable(results: BenchmarkResult[]): void {
  console.log('\n' + '='.repeat(80))
  console.log('RAPPORT DE BENCHMARK — cork-ai')
  console.log('='.repeat(80))

  for (const r of results) {
    console.log(`\n📊 ${r.scenario}`)
    console.log(`   Messages : ${r.messageCount}`)
    console.log(`   Tokens avant : ${r.originalTokens.toLocaleString()}`)
    console.log(`   Tokens après : ${r.compressedTokens.toLocaleString()}`)
    console.log(`   Économisé    : ${r.savedTokens.toLocaleString()} tokens (${r.savingsPercent}%)`)
    console.log(`   Coût économisé : $${r.estimatedCostSaved.toFixed(4)} USD`)
    console.log(`   Durée        : ${r.durationMs}ms`)

    if (Object.keys(r.byModule).length > 0) {
      console.log('   Par module :')
      for (const [name, saved] of Object.entries(r.byModule)) {
        if (saved > 0) {
          console.log(`     - ${name}: ${saved.toLocaleString()} tokens`)
        }
      }
    }
  }

  console.log('\n' + '='.repeat(80))
  console.log('RÉSUMÉ')
  console.log('='.repeat(80))

  console.log('\n| Scénario                  | Tokens avant | Tokens après | Réduction |')
  console.log('|---------------------------|-------------|-------------|-----------|')
  for (const r of results) {
    const name = r.scenario.padEnd(25)
    const before = r.originalTokens.toLocaleString().padStart(11)
    const after = r.compressedTokens.toLocaleString().padStart(11)
    const pct = `${r.savingsPercent}%`.padStart(9)
    console.log(`| ${name} | ${before} | ${after} | ${pct} |`)
  }

  console.log('\n✅ Benchmark terminé.')
}

async function main(): Promise<void> {
  console.log('Génération des sessions de test...')

  const scenarios = [
    {
      name: 'Session courte (15 msgs)',
      messages: generateSession(15),
      budget: 150_000,
    },
    {
      name: 'Session moyenne (40 msgs)',
      messages: generateSession(40),
      budget: 150_000,
    },
    {
      name: 'Session longue (80 msgs)',
      messages: generateSession(80),
      budget: 150_000,
    },
    {
      name: 'Budget serré (80 msgs, 20k)',
      messages: generateSession(80),
      budget: 20_000,
    },
    {
      name: 'Sans headers ni code dup',
      messages: generateSession(40, true, false, false),
      budget: 150_000,
    },
  ]

  const results: BenchmarkResult[] = []
  for (const { name, messages, budget } of scenarios) {
    process.stdout.write(`  ${name}... `)
    const result = await runBenchmark(name, messages, budget)
    results.push(result)
    console.log(`✓ (${result.durationMs}ms)`)
  }

  printTable(results)
}

main().catch(console.error)
