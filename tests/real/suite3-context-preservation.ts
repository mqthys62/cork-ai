/**
 * Suite 3 — Préservation du contexte critique après compression
 *
 * Embeds des "faits critiques" dans des sessions Claude Code réalistes,
 * les compresse à 3 niveaux, puis vérifie programmatiquement que chaque
 * fait survit dans les messages compressés.
 *
 * Logique : si un fait est présent dans les messages compressés → Claude
 * peut le lire → il peut en tenir compte pour produire du code correct.
 *
 * Usage : npx tsx tests/real/suite3-context-preservation.ts
 * Coût  : $0 — aucun appel API
 */

import { CtxForge, countMessageTokens } from '../../src/index.js'
import type { Message } from '../../src/types/index.js'

// ─── Couleurs ────────────────────────────────────────────────────────────────

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m',
  cyan: '\x1b[36m', blue: '\x1b[34m',
}

// ─── Blocs de filler réaliste ─────────────────────────────────────────────────

const ENV = (files: string[]) => `<environment_details>
# VSCode Visible Files
${files[0] ?? 'src/index.ts'}

# VSCode Open Tabs
${files.join('\n')}

# Current Working Directory (/home/user/my-project) Files
${files.map(f => `  ${f}`).join('\n')}
</environment_details>`

const FILLER_FILE = `import { EventEmitter } from 'events'

export class RequestHandler extends EventEmitter {
  private readonly routes = new Map<string, Function>()
  private requestCount = 0

  register(path: string, handler: Function): this {
    this.routes.set(path, handler)
    return this
  }

  handle(req: { url?: string }, res: { writeHead: Function; end: Function }): void {
    this.requestCount++
    const handler = this.routes.get(req.url ?? '/')
    if (!handler) { res.writeHead(404); res.end('Not found'); return }
    try { handler(req, res) } catch (err) {
      this.emit('error', err)
      res.writeHead(500); res.end('Internal server error')
    }
  }

  getStats() { return { requestCount: this.requestCount, routes: this.routes.size } }
}`

const FILLER_BASH = (n: number) => Array.from({ length: n }, (_, i) =>
  `  ✓ test ${String(i + 1).padStart(2)} — ${['router', 'auth', 'config', 'utils', 'middleware'][i % 5]}.test.ts (${15 + i * 3}ms)`,
).join('\n')

/** Génère N tours de messages filler pour pousser la session vers la compression */
function buildFiller(rounds: number): Message[] {
  const msgs: Message[] = []
  for (let i = 0; i < rounds; i++) {
    msgs.push({ role: 'user', content: `${ENV(['src/router.ts', 'src/middleware.ts'])}\n\nÉtape ${i + 1} : vérification du module router.` })
    msgs.push({ role: 'assistant', content: [{ type: 'tool_use', id: `f_tu${i}`, name: 'Read', input: { file_path: 'src/router.ts' } }] })
    msgs.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `f_tu${i}`, content: FILLER_FILE }] })
    msgs.push({ role: 'assistant', content: `Étape ${i + 1} analysée. Le module router est en bon état. ${i % 2 === 0 ? 'Aucune modification nécessaire.' : 'Refactoring mineur suggéré mais non bloquant.'}` })
    if (i % 3 === 0) {
      msgs.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `f_bash${i}`, content: FILLER_BASH(6 + i) }] })
      msgs.push({ role: 'assistant', content: `Tests de l'étape ${i + 1} : tous verts.` })
    }
  }
  return msgs
}

// ─── Définition des pièges ────────────────────────────────────────────────────

interface Trap {
  id: string
  name: string
  category: 'config_value' | 'error_message' | 'architectural_decision' | 'file_path' | 'function_signature'
  description: string
  /** Les messages qui contiennent le fait critique (placés en début de session) */
  setupMessages: Message[]
  /** Mot ou phrase exact à retrouver dans les messages compressés */
  expectedKeyword: string
  /** Raison pour laquelle ce fait est critique pour la qualité du code produit */
  whyItMatters: string
}

const TRAPS: Trap[] = [
  {
    id: 'T1',
    name: 'Port de serveur dans la config',
    category: 'config_value',
    description: 'Valeur exacte dans un message user — risque si heatmap ou summarizer compresse les vieux messages',
    setupMessages: [
      {
        role: 'user',
        content: `${ENV(['src/config.ts'])}\n\nIMPORTANT — contrainte réseau : le serveur de dev DOIT tourner sur le port 9876. Le port 3000 est bloqué par le pare-feu de l'entreprise. Ne jamais changer ça.`,
      },
      {
        role: 'assistant',
        content: 'Noté. Port de dev : 9876 (obligatoire, contrainte réseau). Je mettrai à jour toutes les configurations en conséquence.',
      },
    ],
    expectedKeyword: '9876',
    whyItMatters: 'Si Claude oublie ce port, il générera du code avec port=3000 qui ne fonctionnera pas en entreprise',
  },
  {
    id: 'T2',
    name: 'Variable d\'env dans bash output (premières lignes)',
    category: 'config_value',
    description: 'SERVER_PORT=9876 dans les premières lignes d\'un cat .env — normalement préservé par le tool result compressor',
    setupMessages: [
      { role: 'user', content: 'Lis le fichier .env pour voir la config actuelle.' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'trap2_tu', name: 'Bash', input: { command: 'cat .env' } }] },
      {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'trap2_tu',
          content: [
            '$ cat .env',
            'NODE_ENV=production',
            'SERVER_PORT=9876',
            'DB_HOST=postgres.internal',
            'DB_PORT=5432',
            'DB_NAME=myapp_prod',
            'REDIS_URL=redis://cache.internal:6379',
            'JWT_SECRET=prod-secret-XXXX',
            'LOG_LEVEL=warn',
            'CORS_ORIGIN=https://app.mycompany.com',
            'MAX_CONNECTIONS=50',
            'RATE_LIMIT_MAX=200',
          ].join('\n'),
        }],
      },
      { role: 'assistant', content: 'Config lue. SERVER_PORT=9876 en production.' },
    ],
    expectedKeyword: 'SERVER_PORT=9876',
    whyItMatters: 'Sans cette valeur, Claude ne peut pas correctement configurer les docker-compose, nginx, ou Kubernetes manifests',
  },
  {
    id: 'T3',
    name: 'Nom précis d\'un test en échec',
    category: 'error_message',
    description: 'Stack trace avec nom de test exact — le tool result compressor préserve les lignes d\'erreur',
    setupMessages: [
      { role: 'user', content: 'Lance les tests.' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'trap3_tu', name: 'Bash', input: { command: 'npm test' } }] },
      {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'trap3_tu',
          content: [
            '> my-app@1.0.0 test',
            '> vitest run',
            '',
            ' ✓ tests/utils.test.ts (14 tests)',
            ' ✗ tests/auth.test.ts (3 tests | 1 failed)',
            '   × AuthService › validateToken › should reject expired tokens',
            '     AssertionError: expected false to equal true',
            '       at validateTokenExpiry (src/auth.ts:47:12)',
            ...Array.from({ length: 15 }, (_, i) => `   ✓ test ${i + 1} passed`),
            '',
            ' Tests: 1 failed, 16 passed',
          ].join('\n'),
        }],
      },
      { role: 'assistant', content: 'Un test échoue : `validateToken › should reject expired tokens` dans `src/auth.ts:47`.' },
    ],
    expectedKeyword: 'validateToken',
    whyItMatters: 'Sans le nom exact du test, Claude ne sait pas quelle fonction corriger et peut modifier la mauvaise',
  },
  {
    id: 'T4',
    name: 'Décision architecturale (choix de stack)',
    category: 'architectural_decision',
    description: 'Décision explicite dans un message user — risque de perte si heatmap ou summarizer trop agressif',
    setupMessages: [
      {
        role: 'user',
        content: `${ENV(['src/config.ts'])}\n\nDécision d'équipe validée en réunion : on n'utilise PAS Redis pour le cache dans ce projet. On reste sur un cache en mémoire (Map<string, unknown>). Raison : l'équipe SRE refuse de gérer une autre infra en prod. Cette décision est finale et ne doit pas être remise en question.`,
      },
      {
        role: 'assistant',
        content: 'Décision actée : cache en mémoire uniquement, pas de Redis. Je m\'assurerai de ne jamais introduire de dépendance Redis dans ce codebase.',
      },
    ],
    expectedKeyword: 'Redis',
    whyItMatters: 'Si Claude oublie cette contrainte, il suggérera Redis dans des refactorings futurs, créant un conflit avec l\'équipe SRE',
  },
  {
    id: 'T5',
    name: 'Signature de fonction critique',
    category: 'function_signature',
    description: 'Signature d\'une API publique vue dans un Read — risque si code dedup remplace par référence',
    setupMessages: [
      { role: 'user', content: 'Montre-moi l\'interface publique du module auth.' },
      {
        role: 'assistant',
        content: `Voici l'interface publique de \`src/auth.ts\` :\n\n\`\`\`typescript\nexport function generateToken(\n  payload: Omit<TokenPayload, 'iat' | 'exp'>,\n  config?: AuthConfig\n): string\n\nexport function validateToken(\n  token: string,\n  config?: AuthConfig\n): TokenPayload\n\nexport function authMiddleware(\n  config?: AuthConfig\n): (req: Request, res: Response, next: NextFunction) => void\n\`\`\`\n\nCes 3 fonctions constituent l'API publique. Ne jamais modifier leurs signatures sans mettre à jour tous les appelants.`,
      },
    ],
    expectedKeyword: 'generateToken',
    whyItMatters: 'Si Claude ne connaît plus les signatures exactes, il peut générer des appels incompatibles dans d\'autres modules',
  },
  {
    id: 'T6',
    name: 'Chemin de fichier avec numéro de ligne (stack trace)',
    category: 'file_path',
    description: 'src/auth.ts:47 dans une erreur — les chemins sont extraits verbatim par le selective summarizer',
    setupMessages: [
      {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'trap6_tu',
          content: 'Error: Token expiré\n    at validateToken (src/auth.ts:47:12)\n    at authMiddleware (src/auth.ts:63:28)\n    at Layer.handle [as handle_request] (node_modules/express/lib/router/layer.js:95:5)',
        }],
      },
      { role: 'assistant', content: 'L\'erreur est à `src/auth.ts:47`. La ligne 47 est la comparaison d\'expiration.' },
    ],
    expectedKeyword: 'src/auth.ts',
    whyItMatters: 'Sans le chemin exact, Claude ne sait pas quel fichier ouvrir pour corriger le bug',
  },
]

// ─── Logique de test ──────────────────────────────────────────────────────────

interface TrapTestResult {
  trap: Trap
  results: Array<{
    agg: number
    maxCtx: number
    tokensBefore: number
    tokensAfter: number
    savingsPct: number
    keywordFound: boolean
    keywordContext: string // extrait du contexte autour du mot-clé
  }>
}

function extractKeywordContext(messages: Message[], keyword: string): string {
  const allText = messages.map(m => {
    if (typeof m.content === 'string') return m.content
    return m.content.map(b => {
      if (b.type === 'text') return b.text
      if (b.type === 'tool_result') return typeof b.content === 'string' ? b.content : ''
      if (b.type === 'tool_use') return JSON.stringify(b.input)
      return ''
    }).join(' ')
  }).join(' ')

  const idx = allText.toLowerCase().indexOf(keyword.toLowerCase())
  if (idx === -1) return '(non trouvé)'
  const start = Math.max(0, idx - 30)
  const end = Math.min(allText.length, idx + keyword.length + 30)
  return `...${allText.slice(start, end).replace(/\n/g, ' ').trim()}...`
}

function containsKeyword(messages: Message[], keyword: string): boolean {
  for (const msg of messages) {
    const content = typeof msg.content === 'string'
      ? msg.content
      : msg.content.map(b => {
          if (b.type === 'text') return b.text
          if (b.type === 'tool_result') return typeof b.content === 'string' ? b.content : ''
          if (b.type === 'tool_use') return JSON.stringify(b.input)
          return ''
        }).join(' ')
    if (content.toLowerCase().includes(keyword.toLowerCase())) return true
  }
  return false
}

function runTrapTest(trap: Trap, filler: Message[]): TrapTestResult {
  // Context = setup (piège) + filler (messages qui poussent vers la compression)
  const fullContext: Message[] = [...trap.setupMessages, ...filler]
  const tokensBefore = countMessageTokens(fullContext)

  const results = []
  for (const [agg, maxCtx] of [[0.3, 6000], [0.6, 4000], [0.9, 3000]] as [number, number][]) {
    const forge = new CtxForge({ maxContextTokens: maxCtx, aggressiveness: agg })
    const { messages: compressed, stats } = forge.compress(fullContext)

    const keywordFound = containsKeyword(compressed, trap.expectedKeyword)
    const keywordContext = keywordFound
      ? extractKeywordContext(compressed, trap.expectedKeyword)
      : extractKeywordContext(fullContext, trap.expectedKeyword) + ' [original]'

    results.push({
      agg,
      maxCtx,
      tokensBefore,
      tokensAfter: stats.request.compressedTokens,
      savingsPct: stats.request.savingsPercent,
      keywordFound,
      keywordContext,
    })
  }

  return { trap, results }
}

// ─── Affichage ────────────────────────────────────────────────────────────────

function printTrapResult(r: TrapTestResult): void {
  const cat = r.trap.category
  const catColor: Record<string, string> = {
    config_value: C.blue,
    error_message: C.red,
    architectural_decision: C.magenta,
    file_path: C.cyan,
    function_signature: C.yellow,
  } as Record<string, string>

  console.log(`\n${C.bold}[${r.trap.id}] ${r.trap.name}${C.reset} ${catColor[cat] ?? ''}[${cat}]${C.reset}`)
  console.log(`  ${C.dim}${r.trap.description}${C.reset}`)
  console.log(`  Mot-clé : ${C.bold}"${r.trap.expectedKeyword}"${C.reset} — ${C.dim}${r.trap.whyItMatters}${C.reset}`)
  console.log()

  for (const res of r.results) {
    const icon = res.keywordFound ? `${C.green}✓${C.reset}` : `${C.red}✗${C.reset}`
    const status = res.keywordFound ? `${C.green}PRÉSERVÉ${C.reset}` : `${C.red}PERDU${C.reset}  `
    const pct = `-${res.savingsPct.toFixed(1)}%`.padStart(7)
    const budget = `budget=${res.maxCtx}`
    console.log(`  agg=${res.agg} │ ${icon} ${status} │ ${C.yellow}${pct}${C.reset} tokens │ ${C.dim}${budget}${C.reset}`)
    if (!res.keywordFound) {
      console.log(`    ${C.dim}Contexte original : ${res.keywordContext}${C.reset}`)
    }
  }
}

// ─── Runner ───────────────────────────────────────────────────────────────────

function run(): void {
  console.log(`${C.bold}${C.cyan}
╔══════════════════════════════════════════════════════════════════╗
║     Suite 3 — Préservation du contexte critique                  ║
║     ${TRAPS.length} pièges × 3 niveaux · vérification programmatique    ║
╚══════════════════════════════════════════════════════════════════╝${C.reset}`)

  const filler = buildFiller(7) // 7 rounds = suffisamment pour déclencher la compression
  const fillerTokens = countMessageTokens(filler)
  console.log(`\n${C.dim}Filler généré : ${filler.length} messages, ${fillerTokens} tokens${C.reset}`)

  const testResults = TRAPS.map(trap => runTrapTest(trap, filler))

  console.log(`\n${C.bold}${C.cyan}Résultats détaillés${C.reset}`)
  console.log('═'.repeat(68))

  for (const r of testResults) {
    printTrapResult(r)
  }

  // ─── Résumé par niveau d'agressivité ───────────────────────────────────
  console.log(`\n${C.bold}${C.cyan}════════════════════════════════════════════════════════════════════${C.reset}`)
  console.log(`${C.bold}Résumé — Score de préservation par niveau d'agressivité${C.reset}`)
  console.log(`${C.bold}${C.cyan}════════════════════════════════════════════════════════════════════${C.reset}\n`)

  const aggressivenessLevels = [0.3, 0.6, 0.9]
  for (const agg of aggressivenessLevels) {
    const resultsAtLevel = testResults.map(r => r.results.find(res => res.agg === agg)!)
    const preserved = resultsAtLevel.filter(r => r.keywordFound).length
    const total = resultsAtLevel.length
    const avgSavings = resultsAtLevel.reduce((s, r) => s + r.savingsPct, 0) / total
    const score = (preserved / total * 100).toFixed(0)
    const scoreColor = preserved === total ? C.green : preserved >= total * 0.75 ? C.yellow : C.red

    const icons = resultsAtLevel.map(r => r.keywordFound ? `${C.green}✓${C.reset}` : `${C.red}✗${C.reset}`).join(' ')
    console.log(`  agg=${agg} │ ${icons} │ ${scoreColor}${C.bold}${score}% préservé${C.reset} │ ${C.yellow}-${avgSavings.toFixed(1)}% tokens${C.reset}`)
  }

  // Recommandation
  const ref = testResults.map(r => r.results[1]) // agg=0.6
  const refPreserved = ref.filter(r => r.keywordFound).length
  const refAvgSavings = ref.reduce((s, r) => s + r.savingsPct, 0) / ref.length

  console.log()
  if (refPreserved === TRAPS.length) {
    console.log(`  ${C.green}${C.bold}✓ Verdict agg=0.6 : ${refPreserved}/${TRAPS.length} faits préservés à -${refAvgSavings.toFixed(1)}% de tokens${C.reset}`)
    console.log(`  ${C.green}  → Bon équilibre : économies significatives sans perte de contexte critique${C.reset}`)
  } else {
    console.log(`  ${C.yellow}${C.bold}⚠ Verdict agg=0.6 : ${refPreserved}/${TRAPS.length} faits préservés (${(refPreserved / TRAPS.length * 100).toFixed(0)}%)${C.reset}`)
    const lost = testResults.filter(r => !r.results[1].keywordFound)
    for (const l of lost) {
      console.log(`    ${C.red}✗${C.reset} Perdu : [${l.trap.id}] ${l.trap.name}`)
    }
  }

  console.log()

  // Catégories de risque
  console.log(`  ${C.dim}Catégories évaluées :${C.reset}`)
  const categories = [...new Set(TRAPS.map(t => t.category))]
  for (const cat of categories) {
    const trapsInCat = testResults.filter(r => r.trap.category === cat)
    const catPreserved = trapsInCat.filter(r => r.results[1].keywordFound).length
    const catTotal = trapsInCat.length
    console.log(`    ${catPreserved === catTotal ? C.green : C.red}${cat.padEnd(26)}${C.reset} ${catPreserved}/${catTotal} (agg=0.6)`)
  }

  console.log()
}

run()
