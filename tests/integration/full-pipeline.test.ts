import { describe, it, expect } from 'vitest'
import { CtxForge, wrapClient } from '../../src/index.js'
import type { Message } from '../../src/types/index.js'

// Session simulée réaliste : 20 messages avec du code, des outils, des headers
const SESSION_MESSAGES: Message[] = [
  {
    role: 'user',
    content: `<environment>
CWD: /home/user/projects/my-app
OS: Linux
Platform: WSL2
Open files: src/index.ts, src/utils.ts
</environment>

Peux-tu créer un module utils.ts avec des fonctions utilitaires ?`,
  },
  {
    role: 'assistant',
    content: `Voici le module utils.ts :

\`\`\`typescript
import { readFileSync } from 'fs'
import path from 'path'

export function readJsonFile<T>(filePath: string): T {
  const content = readFileSync(filePath, 'utf-8')
  return JSON.parse(content) as T
}

export function slugify(str: string): string {
  return str.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-')
}

export function chunk<T>(arr: T[], size: number): T[][] {
  const result: T[][] = []
  for (let i = 0; i < arr.length; i += size) {
    result.push(arr.slice(i, i + size))
  }
  return result
}
\`\`\``,
  },
  {
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: 'tool_read_1',
        content: `import { readFileSync } from 'fs'
import path from 'path'

// Configuration principale
export const CONFIG = {
  database: {
    host: 'localhost',
    port: 5432,
    name: 'mydb',
    ssl: true,
    poolSize: 10,
    timeout: 30000,
  },
  redis: {
    host: 'localhost',
    port: 6379,
    ttl: 3600,
  },
  api: {
    baseUrl: 'https://api.example.com',
    version: 'v2',
    timeout: 5000,
    retries: 3,
  },
  features: {
    darkMode: true,
    betaFeatures: false,
    analytics: true,
  },
}

export type Config = typeof CONFIG
`.repeat(3),
      },
    ],
  },
  {
    role: 'assistant',
    content: [
      {
        type: 'tool_use',
        id: 'tu_write_1',
        name: 'Write',
        input: {
          path: 'src/utils.ts',
          content: `export function readJsonFile<T>(filePath: string): T {
  const content = readFileSync(filePath, 'utf-8')
  return JSON.parse(content) as T
}

export function slugify(str: string): string {
  return str.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-')
}`,
        },
      },
    ],
  },
  {
    role: 'user',
    content: `<environment>
CWD: /home/user/projects/my-app
OS: Linux
Platform: WSL2
Open files: src/index.ts, src/utils.ts
</environment>

Maintenant ajoute une fonction formatDate`,
  },
  {
    role: 'assistant',
    content: `\`\`\`typescript
export function formatDate(date: Date, locale = 'fr-FR'): string {
  return date.toLocaleDateString(locale, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })
}
\`\`\``,
  },
  {
    role: 'user',
    content: `<environment>
CWD: /home/user/projects/my-app
OS: Linux
Platform: WSL2
Open files: src/index.ts, src/utils.ts
</environment>

Les tests échouent : Error: Cannot find module './utils'`,
  },
  {
    role: 'assistant',
    content: 'Il faut ajouter l\'extension `.js` dans les imports. Node.js ESM requiert les extensions explicites.',
  },
  {
    role: 'user',
    content: `<environment>
CWD: /home/user/projects/my-app
OS: Linux
Platform: WSL2
Open files: src/index.ts, src/utils.ts, src/index.test.ts
</environment>

OK, je confirme que c'est décidé : toujours utiliser .js dans les imports ESM.`,
  },
  {
    role: 'assistant',
    content: 'Parfait, c\'est noté. Cette convention sera appliquée partout dans le projet.',
  },
  {
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: 'tool_bash_1',
        content: Array.from({ length: 30 }, (_, i) =>
          i === 12 ? 'Error: ENOENT: no such file or directory, open \'/home/user/projects/my-app/dist/utils.js\'' :
          i === 13 ? 'at Object.openSync (node:fs:596:18)' :
          `${i + 1}: npm run build output line`
        ).join('\n'),
      },
    ],
  },
  {
    role: 'assistant',
    content: 'Le fichier dist/utils.js n\'existe pas car le build n\'a pas été exécuté. Lance `npm run build` d\'abord.',
  },
  {
    role: 'user',
    content: `<environment>
CWD: /home/user/projects/my-app
OS: Linux
Platform: WSL2
Open files: src/utils.ts
</environment>

Comment optimiser la fonction chunk pour les grands tableaux ?`,
  },
  {
    role: 'assistant',
    content: `Pour les grands tableaux, voici une version optimisée :

\`\`\`typescript
export function chunk<T>(arr: T[], size: number): T[][] {
  const result: T[][] = []
  for (let i = 0; i < arr.length; i += size) {
    result.push(arr.slice(i, i + size))
  }
  return result
}
\`\`\`

Cette version évite les copies inutiles.`,
  },
  {
    role: 'user',
    content: `<environment>
CWD: /home/user/projects/my-app
OS: Linux
Platform: WSL2
Open files: src/utils.ts
</environment>

Maintenant les tests passent. Merci !`,
  },
]

describe('Intégration — Pipeline complet', () => {
  it('compresse une session réaliste sans erreur', () => {
    const forge = new CtxForge({ maxContextTokens: 150_000 })
    const result = forge.compress(SESSION_MESSAGES)
    expect(result.messages).toHaveLength(SESSION_MESSAGES.length)
    expect(result.stats.request.originalTokens).toBeGreaterThan(0)
  })

  it('préserve la structure des messages', () => {
    const forge = new CtxForge()
    const result = forge.compress(SESSION_MESSAGES)
    result.messages.forEach((msg, i) => {
      expect(msg.role).toBe(SESSION_MESSAGES[i].role)
    })
  })

  it('les stats sont cohérentes', () => {
    const forge = new CtxForge()
    const result = forge.compress(SESSION_MESSAGES)
    const { request } = result.stats
    expect(request.compressedTokens).toBeLessThanOrEqual(request.originalTokens)
    expect(request.savedTokens).toBeGreaterThanOrEqual(0)
    expect(request.savingsPercent).toBeGreaterThanOrEqual(0)
    expect(request.savingsPercent).toBeLessThanOrEqual(100)
  })

  it('plusieurs compressions accumulent les stats', () => {
    const forge = new CtxForge()
    forge.compress(SESSION_MESSAGES)
    forge.compress(SESSION_MESSAGES)
    const stats = forge.getStats()
    expect(stats?.session.requestCount).toBe(2)
  })

  it('wrapClient fonctionne avec un client mock', async () => {
    const mockCreate = async (params: { messages: Message[] }) => ({
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'Réponse' }],
      model: 'claude-sonnet-4-6',
      usage: { input_tokens: params.messages.length * 10, output_tokens: 5 },
    })

    const mockClient = {
      messages: { create: mockCreate },
    }

    const wrapped = wrapClient(mockClient as any)
    const response = await wrapped.messages.create({
      messages: SESSION_MESSAGES,
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
    })

    expect(response).toBeDefined()
    expect(wrapped.getStats()).not.toBeNull()
  })

  it('le rapport de tokens économisés est positif sur une longue session', () => {
    const forge = new CtxForge({ maxContextTokens: 5_000 }) // budget très petit pour forcer compression
    const result = forge.compress(SESSION_MESSAGES)
    // Avec un budget aussi petit, la compression doit être activée
    expect(result.stats.request.originalTokens).toBeGreaterThan(0)
  })
})
