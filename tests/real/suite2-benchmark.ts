/**
 * Suite 2 — Benchmark sur sessions Claude Code réalistes
 *
 * Simule 4 types de sessions Claude Code (bug fix, feature, refacto, debug long)
 * et mesure l'économie réelle de tokens à 3 niveaux d'agressivité.
 *
 * Usage : npx tsx tests/real/suite2-benchmark.ts
 * Coût  : $0 — aucun appel API
 */

import { CtxForge, countMessageTokens } from '../../src/index.js'
import type { Message } from '../../src/types/index.js'

// ─── Couleurs terminal ────────────────────────────────────────────────────────

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m',
  cyan: '\x1b[36m', blue: '\x1b[34m', magenta: '\x1b[35m',
}

// ─── Blocs réalistes Claude Code ──────────────────────────────────────────────

/** Format exact des environment_details injectés par Claude Code dans chaque message */
const ENV = (files: string[], cwd = '/home/user/my-project') => `<environment_details>
# VSCode Visible Files
${files.slice(0, 2).join('\n')}

# VSCode Open Tabs
${files.join('\n')}

# Current Working Directory (${cwd}) Files
src/
${files.map(f => `  ${f}`).join('\n')}
tests/
  auth.test.ts
  utils.test.ts
</environment_details>`

const AUTH_TS = `import { createHash, randomBytes } from 'crypto'
import type { Request, Response, NextFunction } from 'express'

export interface TokenPayload {
  userId: string
  email: string
  role: 'admin' | 'user' | 'guest'
  iat: number
  exp: number
}

export interface AuthConfig {
  secret: string
  expiresIn: number
  algorithm: 'sha256' | 'sha512'
  issuer: string
}

const DEFAULT_CONFIG: AuthConfig = {
  secret: process.env['JWT_SECRET'] ?? 'fallback-dev-secret',
  expiresIn: 3600,
  algorithm: 'sha256',
  issuer: 'my-app',
}

export function generateToken(payload: Omit<TokenPayload, 'iat' | 'exp'>, config = DEFAULT_CONFIG): string {
  const iat = Math.floor(Date.now() / 1000)
  const exp = iat + config.expiresIn
  const header = Buffer.from(JSON.stringify({ alg: config.algorithm, typ: 'JWT' })).toString('base64url')
  const body = Buffer.from(JSON.stringify({ ...payload, iat, exp, iss: config.issuer })).toString('base64url')
  const signature = createHash(config.algorithm)
    .update(\`\${header}.\${body}.\${config.secret}\`)
    .digest('base64url')
  return \`\${header}.\${body}.\${signature}\`
}

export function validateToken(token: string, config = DEFAULT_CONFIG): TokenPayload {
  const parts = token.split('.')
  if (parts.length !== 3) throw new Error('Token format invalide')

  const [header, body, signature] = parts
  const expectedSig = createHash(config.algorithm)
    .update(\`\${header}.\${body}.\${config.secret}\`)
    .digest('base64url')

  if (signature !== expectedSig) throw new Error('Signature invalide')

  const payload = JSON.parse(Buffer.from(body, 'base64url').toString()) as TokenPayload
  const now = Math.floor(Date.now() / 1000)

  if (payload.exp < now) throw new Error('Token expiré')
  if (payload.iss !== config.issuer) throw new Error('Issuer invalide')

  return payload
}

export function authMiddleware(config = DEFAULT_CONFIG) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const authHeader = req.headers.authorization
    if (!authHeader?.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Token manquant ou format invalide' })
      return
    }
    try {
      const token = authHeader.slice(7)
      const payload = validateToken(token, config)
      ;(req as Request & { user: TokenPayload }).user = payload
      next()
    } catch (err) {
      res.status(401).json({ error: (err as Error).message })
    }
  }
}`

const CONFIG_TS = `import { readFileSync } from 'fs'
import path from 'path'

export interface DatabaseConfig {
  host: string
  port: number
  name: string
  user: string
  password: string
  poolSize: number
  ssl: boolean
  connectionTimeout: number
}

export interface CacheConfig {
  strategy: 'memory' | 'redis'
  ttl: number
  maxSize: number
  redisUrl?: string
}

export interface AppConfig {
  port: number
  env: 'development' | 'staging' | 'production'
  database: DatabaseConfig
  cache: CacheConfig
  cors: { origin: string[]; credentials: boolean }
  rateLimit: { windowMs: number; max: number }
}

export const DEFAULT_CONFIG: AppConfig = {
  port: parseInt(process.env['PORT'] ?? '3000', 10),
  env: (process.env['NODE_ENV'] ?? 'development') as AppConfig['env'],
  database: {
    host: process.env['DB_HOST'] ?? 'localhost',
    port: parseInt(process.env['DB_PORT'] ?? '5432', 10),
    name: process.env['DB_NAME'] ?? 'myapp_dev',
    user: process.env['DB_USER'] ?? 'postgres',
    password: process.env['DB_PASSWORD'] ?? '',
    poolSize: 10,
    ssl: process.env['NODE_ENV'] === 'production',
    connectionTimeout: 30_000,
  },
  cache: {
    strategy: 'memory',
    ttl: 3600,
    maxSize: 1000,
  },
  cors: {
    origin: (process.env['CORS_ORIGIN'] ?? 'http://localhost:3000').split(','),
    credentials: true,
  },
  rateLimit: {
    windowMs: 15 * 60 * 1000,
    max: 100,
  },
}

export function loadConfig(filePath?: string): AppConfig {
  if (!filePath) return DEFAULT_CONFIG
  try {
    const raw = readFileSync(path.resolve(filePath), 'utf-8')
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) } as AppConfig
  } catch {
    console.warn(\`Config file not found at \${filePath}, using defaults\`)
    return DEFAULT_CONFIG
  }
}`

const TEST_OUTPUT_FAIL = `> my-app@1.0.0 test
> vitest run

 DEV  v2.1.8 /home/user/my-project

 ✓ tests/utils.test.ts (14 tests) 47ms
 ✗ tests/auth.test.ts (3 tests | 1 failed) 23ms
   × AuthService › validateToken › should reject expired tokens
     AssertionError: expected false to equal true
       at validateTokenExpiry (src/auth.ts:47:12)
       at Object.<anonymous> (tests/auth.test.ts:89:5)

 Test Files  1 failed | 1 passed (2)
 Tests       1 failed | 16 passed (17)
 Duration    312ms`

const TEST_OUTPUT_PASS = `> my-app@1.0.0 test
> vitest run

 DEV  v2.1.8 /home/user/my-project

 ✓ tests/utils.test.ts (14 tests) 45ms
 ✓ tests/auth.test.ts (4 tests) 31ms

 Test Files  2 passed (2)
 Tests       18 passed (18)
 Duration    298ms`

const BUILD_OUTPUT = [
  '> my-app@1.0.0 build',
  '> tsc && tsup src/index.ts --format cjs,esm --dts',
  '',
  ...Array.from({ length: 40 }, (_, i) => `[${String(i + 1).padStart(2)}/${40}] Compiling ${['src/auth.ts', 'src/config.ts', 'src/utils.ts', 'src/router.ts', 'src/middleware.ts'][i % 5]}...`),
  '',
  'dist/index.js     124.3 KB',
  'dist/index.mjs     98.1 KB',
  'dist/index.d.ts    21.4 KB',
  '',
  '✓ Build réussi en 4.2s',
].join('\n')

// ─── Constructeurs de sessions ─────────────────────────────────────────────

/**
 * Session 1 : Bug fix courte (10 messages)
 * Typique : lire un fichier, corriger un bug, vérifier les tests.
 */
function buildBugFixSession(): Message[] {
  return [
    { role: 'user', content: `${ENV(['src/auth.ts', 'tests/auth.test.ts'])}\n\nLes tests auth échouent. Peux-tu regarder le problème ?` },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: 'src/auth.ts' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: AUTH_TS }] },
    { role: 'assistant', content: `J'ai trouvé le problème. Dans \`validateToken\`, la comparaison d'expiration utilise \`<\` au lieu de \`<=\`. Voici la correction :\n\n\`\`\`typescript\nif (payload.exp <= now) throw new Error('Token expiré')\n\`\`\`` },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'tu2', content: 'Edit appliqué : src/auth.ts ligne 47' },
        { type: 'tool_result', tool_use_id: 'tu3', content: TEST_OUTPUT_FAIL },
      ],
    },
    { role: 'assistant', content: `${ENV(['src/auth.ts', 'tests/auth.test.ts'])}\n\nJe relis le test pour voir l'assertion exacte.` },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu4', content: `import { validateToken, generateToken } from '../src/auth.js'\n\ndescribe('AuthService', () => {\n  it('validateToken - should reject expired tokens', () => {\n    const expiredToken = generateToken({ userId: '1', email: 'a@b.com', role: 'user' }, { ...DEFAULT_CONFIG, expiresIn: -1 })\n    expect(() => validateToken(expiredToken)).toThrow('Token expiré')\n  })\n})` }] },
    { role: 'assistant', content: `La logique de génération crée un token avec \`exp = iat + (-1)\`, donc \`exp < iat\`. La comparaison \`exp < now\` est la bonne — le vrai problème est dans l'ordre des parts.split(). Correction :` },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'tu5', content: 'Edit appliqué.' },
        { type: 'tool_result', tool_use_id: 'tu6', content: TEST_OUTPUT_PASS },
      ],
    },
    { role: 'assistant', content: `${ENV(['src/auth.ts'])}\n\nTous les tests passent maintenant. Le bug était dans l'ordre de déstructuration.` },
  ]
}

/**
 * Session 2 : Implémentation de feature (20 messages)
 * Typique : plusieurs fichiers, écriture, tests, itérations.
 */
function buildFeatureSession(): Message[] {
  const msgs: Message[] = []

  msgs.push({ role: 'user', content: `${ENV(['src/config.ts', 'src/index.ts'])}\n\nAjoute un middleware de rate limiting basé sur la config existante.` })

  // Première itération : lecture + plan
  msgs.push({ role: 'assistant', content: [{ type: 'tool_use', id: 'tu_r1', name: 'Read', input: { file_path: 'src/config.ts' } }] })
  msgs.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_r1', content: CONFIG_TS }] })
  msgs.push({
    role: 'assistant',
    content: `La config a déjà un champ \`rateLimit\`. Je vais créer \`src/middleware/rate-limit.ts\`.\n\n\`\`\`typescript\nimport type { Request, Response, NextFunction } from 'express'\nimport type { AppConfig } from '../config.js'\n\ninterface RateLimitEntry { count: number; resetAt: number }\nconst store = new Map<string, RateLimitEntry>()\n\nexport function rateLimitMiddleware(config: AppConfig['rateLimit']) {\n  return (req: Request, res: Response, next: NextFunction): void => {\n    const key = req.ip ?? 'unknown'\n    const now = Date.now()\n    const entry = store.get(key)\n    if (!entry || entry.resetAt < now) {\n      store.set(key, { count: 1, resetAt: now + config.windowMs })\n      next()\n      return\n    }\n    if (entry.count >= config.max) {\n      res.status(429).json({ error: 'Too Many Requests' })\n      return\n    }\n    entry.count++\n    next()\n  }\n}\`\`\``,
  })
  msgs.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_w1', content: 'Fichier créé : src/middleware/rate-limit.ts' }] })

  // Deuxième itération : intégration
  for (let i = 0; i < 4; i++) {
    msgs.push({ role: 'user', content: `${ENV(['src/index.ts', 'src/middleware/rate-limit.ts', 'src/config.ts'])}\n\nÉtape ${i + 2} : ${['Intègre le middleware dans index.ts', 'Ajoute les tests', 'Corrige le type error', 'Vérifie le build'][i]}` })
    msgs.push({ role: 'assistant', content: [{ type: 'tool_use', id: `tu_r${i + 2}`, name: 'Read', input: { file_path: 'src/config.ts' } }] })
    msgs.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `tu_r${i + 2}`, content: CONFIG_TS }] })
    msgs.push({
      role: 'assistant',
      content: `Action ${i + 2} effectuée.\n\n\`\`\`typescript\n// src/index.ts\nimport { rateLimitMiddleware } from './middleware/rate-limit.js'\nimport { DEFAULT_CONFIG } from './config.js'\n\napp.use(rateLimitMiddleware(DEFAULT_CONFIG.rateLimit))\n\`\`\``,
    })
    msgs.push({
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: `tu_t${i}`,
        content: i === 3 ? BUILD_OUTPUT : TEST_OUTPUT_PASS,
      }],
    })
  }

  return msgs
}

/**
 * Session 3 : Refactoring multi-fichiers (28 messages)
 * Typique : analyse de l'existant, plusieurs fichiers lus à répétition, réécriture.
 */
function buildRefactoringSession(): Message[] {
  const msgs: Message[] = []

  msgs.push({ role: 'user', content: `${ENV(['src/auth.ts', 'src/config.ts', 'src/index.ts'])}\n\nRefactoring : extraire la logique JWT dans un service dédié. Analyse d'abord tous les fichiers concernés.` })

  // Phase analyse : lire tous les fichiers
  for (const file of ['auth.ts', 'config.ts', 'index.ts']) {
    msgs.push({ role: 'assistant', content: [{ type: 'tool_use', id: `tu_r_${file}`, name: 'Read', input: { file_path: `src/${file}` } }] })
    msgs.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `tu_r_${file}`, content: file === 'auth.ts' ? AUTH_TS : CONFIG_TS }] })
  }

  msgs.push({
    role: 'assistant',
    content: `Analyse terminée. Plan de refactoring :\n1. Créer \`src/services/jwt.service.ts\`\n2. Extraire \`generateToken\` et \`validateToken\`\n3. Conserver \`authMiddleware\` dans \`auth.ts\` mais en dépendant du service\n\n\`\`\`typescript\n// src/services/jwt.service.ts\nexport class JwtService {\n  constructor(private readonly config: AuthConfig) {}\n  generate(payload: Omit<TokenPayload, 'iat' | 'exp'>): string {\n    return generateToken(payload, this.config)\n  }\n  validate(token: string): TokenPayload {\n    return validateToken(token, this.config)\n  }\n}\n\`\`\``,
  })

  // Phase réécriture : itérations avec relecture de fichiers
  for (let i = 0; i < 5; i++) {
    msgs.push({ role: 'user', content: `${ENV(['src/auth.ts', 'src/services/jwt.service.ts'])}\n\nItération ${i + 1} du refactoring.` })
    // On relit auth.ts à chaque itération (simule le comportement réel de Claude Code)
    msgs.push({ role: 'assistant', content: [{ type: 'tool_use', id: `tu_re${i}`, name: 'Read', input: { file_path: 'src/auth.ts' } }] })
    msgs.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `tu_re${i}`, content: AUTH_TS }] })
    msgs.push({
      role: 'assistant',
      content: `Itération ${i + 1} : modification appliquée.\n\n\`\`\`typescript\n${AUTH_TS.slice(0, 200)}...\n\`\`\``,
    })
    msgs.push({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: `tu_t${i}`, content: i === 4 ? TEST_OUTPUT_PASS : TEST_OUTPUT_FAIL }],
    })
  }

  return msgs
}

/**
 * Session 4 : Debug long avec répétitions (42 messages)
 * Typique : problème complexe, nombreuses lectures, outputs bash lourds.
 */
function buildLongDebugSession(): Message[] {
  const msgs: Message[] = []

  msgs.push({ role: 'user', content: `${ENV(['src/auth.ts', 'src/config.ts'])}\n\nLe service auth plante en production. JWT_SECRET non défini. Déboguer.` })

  // Phase de diagnostic : lire tous les fichiers de config
  for (let round = 0; round < 6; round++) {
    msgs.push({ role: 'user', content: `${ENV(['src/auth.ts', 'src/config.ts', '.env', 'Dockerfile'])}\n\nRound ${round + 1} : ${['Vérifier les variables d\'env', 'Inspecter le Dockerfile', 'Relire la config', 'Tester localement', 'Vérifier les logs prod', 'Valider la solution'][round]}` })
    msgs.push({ role: 'assistant', content: [{ type: 'tool_use', id: `tu_d${round}_a`, name: 'Read', input: { file_path: 'src/auth.ts' } }] })
    msgs.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `tu_d${round}_a`, content: AUTH_TS }] })
    msgs.push({ role: 'assistant', content: [{ type: 'tool_use', id: `tu_d${round}_b`, name: 'Bash', input: { command: `env | grep -i jwt && cat .env | grep -v '#'` } }] })
    msgs.push({
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: `tu_d${round}_b`,
        content: round < 3 ? BUILD_OUTPUT : `JWT_SECRET=production-secret-${round}\nDB_HOST=prod.db.internal\nNODE_ENV=production\nPORT=8080`,
      }],
    })
    msgs.push({
      role: 'assistant',
      content: `Round ${round + 1} analysé. ${round < 3 ? 'La variable JWT_SECRET n\'est pas correctement propagée depuis le Dockerfile.' : 'JWT_SECRET est maintenant définie. Le problème venait du timing d\'initialisation.'}`,
    })
  }

  // Phase validation finale
  msgs.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_final', content: TEST_OUTPUT_PASS }] })
  msgs.push({ role: 'assistant', content: 'Tous les tests passent. Le bug était dans l\'ordre d\'initialisation des env vars au démarrage.' })

  return msgs
}

// ─── Benchmark ────────────────────────────────────────────────────────────────

interface BenchResult {
  name: string
  messages: number
  tokensRaw: number
  results: Array<{
    agg: number
    maxCtx: number
    tokensAfter: number
    savedTokens: number
    savingsPct: number
    byModule: Record<string, { saved: number; runs: number }>
    level: 'none' | 'level1' | 'level2' | 'all'
  }>
}

function determineLevel(ratio: number): 'none' | 'level1' | 'level2' | 'all' {
  if (ratio < 0.40) return 'none'
  if (ratio < 0.65) return 'level1'
  if (ratio < 0.80) return 'level2'
  return 'all'
}

function bar(pct: number, width = 30): string {
  const filled = Math.round(pct / 100 * width)
  return `${C.green}${'█'.repeat(filled)}${C.dim}${'░'.repeat(width - filled)}${C.reset}`
}

function usd(tokens: number): string {
  // Sonnet 4.6 : $3/1M input tokens
  const cost = (tokens / 1_000_000) * 3.0
  return cost < 0.01 ? `<$0.01` : `$${cost.toFixed(3)}`
}

function runBenchmark(name: string, session: Message[], maxCtx: number): BenchResult {
  const tokensRaw = countMessageTokens(session)
  const results = []

  for (const agg of [0.3, 0.6, 0.9]) {
    const forge = new CtxForge({ maxContextTokens: maxCtx, aggressiveness: agg })
    const { stats } = forge.compress(session)
    const ratio = tokensRaw / maxCtx
    results.push({
      agg,
      maxCtx,
      tokensAfter: stats.request.compressedTokens,
      savedTokens: stats.request.savedTokens,
      savingsPct: stats.request.savingsPercent,
      byModule: stats.byModule,
      level: determineLevel(ratio),
    })
  }

  return { name, messages: session.length, tokensRaw, results }
}

function printBenchResult(r: BenchResult): void {
  console.log(`\n${C.bold}${C.cyan}${r.name}${C.reset} ${C.dim}(${r.messages} messages, ${r.tokensRaw.toLocaleString()} tokens bruts)${C.reset}`)
  console.log(`${'─'.repeat(68)}`)

  const nominalResult = r.results[1] // agg=0.6 comme référence
  console.log(`  Niveau de compression : ${C.yellow}${nominalResult.level}${C.reset} (ratio ${(r.tokensRaw / nominalResult.maxCtx * 100).toFixed(0)}% du budget)`)
  console.log()

  for (const res of r.results) {
    const label = `agg=${res.agg}`
    const pctStr = `${res.savingsPct.toFixed(1)}%`.padStart(6)
    const color = res.savingsPct > 50 ? C.green : res.savingsPct > 20 ? C.yellow : C.dim
    console.log(`  ${label} │ ${bar(res.savingsPct)} ${color}${pctStr}${C.reset} │ -${res.savedTokens.toLocaleString().padStart(6)} tokens │ économie ≈ ${usd(res.savedTokens)}`)
  }

  // Détail des modules pour agg=0.6
  const refResult = r.results[1]
  if (Object.keys(refResult.byModule).length > 0) {
    console.log()
    console.log(`  ${C.dim}Modules actifs (agg=0.6) :${C.reset}`)
    const sortedModules = Object.entries(refResult.byModule)
      .sort((a, b) => b[1].saved - a[1].saved)
    for (const [mod, stats] of sortedModules) {
      if (stats.saved === 0) continue
      const modPct = r.tokensRaw > 0 ? (stats.saved / r.tokensRaw * 100).toFixed(1) : '0.0'
      console.log(`    ${C.dim}${mod.padEnd(24)}${C.reset} -${stats.saved.toLocaleString().padStart(5)} tokens (${modPct}%)`)
    }
  }
}

// ─── Runner ───────────────────────────────────────────────────────────────────

function run(): void {
  console.log(`${C.bold}${C.cyan}
╔══════════════════════════════════════════════════════════════════╗
║     Suite 2 — Benchmark sessions Claude Code réalistes           ║
║     Simule 4 types de sessions · 3 niveaux d'agressivité         ║
║     Budget : 8 000 tokens (≈ usage courant sur sessions moyennes) ║
╚══════════════════════════════════════════════════════════════════╝${C.reset}`)

  const MAX_CTX = 8_000

  const sessions: Array<[string, Message[]]> = [
    ['Session 1 — Bug fix courte', buildBugFixSession()],
    ['Session 2 — Implémentation feature', buildFeatureSession()],
    ['Session 3 — Refactoring multi-fichiers', buildRefactoringSession()],
    ['Session 4 — Debug long avec répétitions', buildLongDebugSession()],
  ]

  const benchmarks = sessions.map(([name, msgs]) => runBenchmark(name, msgs, MAX_CTX))

  for (const b of benchmarks) {
    printBenchResult(b)
  }

  // ─── Résumé global ──────────────────────────────────────────────────────
  const totalRaw = benchmarks.reduce((s, b) => s + b.tokensRaw, 0)
  const totalSaved06 = benchmarks.reduce((s, b) => s + b.results[1].savedTokens, 0)
  const totalAfter06 = benchmarks.reduce((s, b) => s + b.results[1].tokensAfter, 0)
  const globalPct = (totalSaved06 / totalRaw * 100).toFixed(1)

  console.log(`\n${C.bold}${C.cyan}════════════════════════════════════════════════════════════════════${C.reset}`)
  console.log(`${C.bold}Résumé global (4 sessions, agg=0.6)${C.reset}`)
  console.log(`${C.bold}${C.cyan}════════════════════════════════════════════════════════════════════${C.reset}`)
  console.log()
  console.log(`  Tokens bruts      : ${C.bold}${totalRaw.toLocaleString()}${C.reset}`)
  console.log(`  Tokens compressés : ${C.bold}${totalAfter06.toLocaleString()}${C.reset}`)
  console.log(`  Économie globale  : ${C.green}${C.bold}-${totalSaved06.toLocaleString()} tokens (${globalPct}%)${C.reset}`)
  console.log(`  Coût évité        : ${C.green}${C.bold}${usd(totalSaved06)} / session type${C.reset} ${C.dim}(@ $3/1M tokens Sonnet)${C.reset}`)
  console.log()

  // Projection sur 30 sessions/jour
  const SESSIONS_PER_DAY = 30
  const dailySavings = totalSaved06 * SESSIONS_PER_DAY
  const monthlySavings = dailySavings * 22 // jours ouvrés
  console.log(`  Projection ${SESSIONS_PER_DAY} sessions/jour :`)
  console.log(`    Quotidien  : -${dailySavings.toLocaleString()} tokens ≈ ${usd(dailySavings)}`)
  console.log(`    Mensuel    : -${monthlySavings.toLocaleString()} tokens ≈ ${usd(monthlySavings)}`)
  console.log()

  // Vérification : les stats sont-elles cohérentes ?
  const allCoherent = benchmarks.every(b =>
    b.results.every(r =>
      r.savedTokens + r.tokensAfter === b.tokensRaw &&
      r.savingsPct >= 0 && r.savingsPct <= 100,
    ),
  )

  console.log(allCoherent
    ? `  ${C.green}✓ Toutes les stats sont mathématiquement cohérentes${C.reset}`
    : `  ${C.red}✗ Incohérence détectée dans les stats${C.reset}`,
  )
  console.log()
}

run()
