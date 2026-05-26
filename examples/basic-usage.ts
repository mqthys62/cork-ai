/**
 * Exemple minimal — utilisation de CtxForge pour compression à la demande.
 * Exécuter : tsx examples/basic-usage.ts
 */

import { CtxForge } from '../src/index.js'
import type { Message } from '../src/types/index.js'

// Historique de conversation simulé
const conversationHistory: Message[] = [
  { role: 'user', content: 'Crée un fichier TypeScript avec une classe UserService.' },
  {
    role: 'assistant',
    content: `Voici UserService :

\`\`\`typescript
export class UserService {
  private users: Map<string, User> = new Map()

  async findById(id: string): Promise<User | null> {
    return this.users.get(id) ?? null
  }

  async create(data: Omit<User, 'id'>): Promise<User> {
    const id = crypto.randomUUID()
    const user = { id, ...data }
    this.users.set(id, user)
    return user
  }
}
\`\`\``,
  },
  {
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: 'read_1',
        content: `// src/user.service.ts
export interface User {
  id: string
  name: string
  email: string
  role: 'admin' | 'user'
  createdAt: Date
}

export class UserService {
  private users: Map<string, User> = new Map()

  async findById(id: string): Promise<User | null> {
    return this.users.get(id) ?? null
  }

  async findAll(): Promise<User[]> {
    return Array.from(this.users.values())
  }

  async create(data: Omit<User, 'id' | 'createdAt'>): Promise<User> {
    const id = crypto.randomUUID()
    const user: User = { id, ...data, createdAt: new Date() }
    this.users.set(id, user)
    return user
  }

  async update(id: string, data: Partial<Omit<User, 'id'>>): Promise<User | null> {
    const existing = this.users.get(id)
    if (!existing) return null
    const updated = { ...existing, ...data }
    this.users.set(id, updated)
    return updated
  }

  async delete(id: string): Promise<boolean> {
    return this.users.delete(id)
  }
}`.repeat(4), // répéter pour simuler un long fichier
      },
    ],
  },
  { role: 'assistant', content: 'J\'ai lu le fichier. Il contient UserService avec 5 méthodes CRUD.' },
  { role: 'user', content: 'Ajoute une méthode findByEmail.' },
  {
    role: 'assistant',
    content: `Voici la méthode findByEmail :

\`\`\`typescript
async findByEmail(email: string): Promise<User | null> {
  for (const user of this.users.values()) {
    if (user.email === email) return user
  }
  return null
}
\`\`\``,
  },
]

// ─── Usage avec CtxForge ──────────────────────────────────────────────────────

const forge = new CtxForge({
  maxContextTokens: 150_000,
  aggressiveness: 0.6,
  debug: false,
})

console.log('=== cork-ai — Exemple basique ===\n')
console.log(`Messages d'entrée : ${conversationHistory.length}`)

const { messages, stats } = forge.compress(conversationHistory)

console.log(`\n📊 Résultats de compression :`)
console.log(`  Tokens avant : ${stats.request.originalTokens}`)
console.log(`  Tokens après : ${stats.request.compressedTokens}`)
console.log(`  Économisé   : ${stats.request.savedTokens} tokens (${stats.request.savingsPercent}%)`)
console.log(`  Coût économisé : $${stats.request.estimatedCostSaved}`)

if (Object.keys(stats.byModule).length > 0) {
  console.log('\n📦 Par module :')
  for (const [name, data] of Object.entries(stats.byModule)) {
    console.log(`  ${name}: ${data.saved} tokens économisés (${data.runs} run(s))`)
  }
}

console.log('\n✅ Les messages compressés sont prêts à être envoyés à l\'API Anthropic.')
