import { describe, it, expect, afterEach } from 'vitest'
import { SessionCache, saveSession, loadSession } from '../../src/managers/session-cache.js'
import fs from 'fs'
import path from 'path'
import os from 'os'
import type { Message } from '../../src/types/index.js'

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cork-ai-test-'))
}

const SESSION_MESSAGES: Message[] = [
  { role: 'user', content: 'On va utiliser PostgreSQL pour la base de données, c\'est décidé.' },
  { role: 'assistant', content: 'Parfait. La convention de nommage pour les tables sera snake_case.' },
  {
    role: 'assistant',
    content: [
      {
        type: 'tool_use',
        id: 'tu_1',
        name: 'Write',
        input: {
          path: 'src/database.ts',
          content: 'export async function connect(): Promise<void> {\n  // connexion DB\n}\nexport interface DbConfig { host: string; port: number }',
        },
      },
    ],
  },
  {
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: 'tu_1',
        content: 'Error: ECONNREFUSED - impossible de se connecter à PostgreSQL',
      },
    ],
  },
  { role: 'assistant', content: 'L\'erreur vient du fait que PostgreSQL n\'est pas démarré. Solution : docker compose up -d postgres' },
]

describe('saveSession / loadSession', () => {
  let tmpDir: string

  afterEach(() => {
    // Nettoyer le répertoire temporaire
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    } catch {}
  })

  it('sauvegarde et charge le snapshot', () => {
    tmpDir = makeTempDir()
    saveSession(SESSION_MESSAGES, tmpDir)
    const loaded = loadSession(tmpDir)
    expect(loaded).not.toBeNull()
    expect(typeof loaded).toBe('string')
  })

  it('le snapshot contient les décisions', () => {
    tmpDir = makeTempDir()
    saveSession(SESSION_MESSAGES, tmpDir)
    const loaded = loadSession(tmpDir)
    expect(loaded).toContain('PostgreSQL')
  })

  it('le snapshot contient les fichiers clés', () => {
    tmpDir = makeTempDir()
    saveSession(SESSION_MESSAGES, tmpDir)
    const loaded = loadSession(tmpDir)
    // Le fichier src/database.ts doit être mentionné
    expect(loaded).toContain('database.ts')
  })

  it('crée le répertoire .cork-ai/cache si absent', () => {
    tmpDir = makeTempDir()
    saveSession(SESSION_MESSAGES, tmpDir)
    const cacheDir = path.join(tmpDir, '.cork-ai', 'cache')
    expect(fs.existsSync(cacheDir)).toBe(true)
  })

  it('retourne null si aucun cache n\'existe', () => {
    tmpDir = makeTempDir()
    const result = loadSession(tmpDir)
    expect(result).toBeNull()
  })

  it('le même projet hash donne le même fichier', () => {
    tmpDir = makeTempDir()
    saveSession(SESSION_MESSAGES, tmpDir)
    // Sauvegarder deux fois, vérifier que le fichier existe
    saveSession(SESSION_MESSAGES, tmpDir)
    const files = fs.readdirSync(path.join(tmpDir, '.cork-ai', 'cache'))
    expect(files.length).toBe(1)
  })

  it('gère les messages vides', () => {
    tmpDir = makeTempDir()
    expect(() => saveSession([], tmpDir)).not.toThrow()
    const loaded = loadSession(tmpDir)
    expect(loaded).not.toBeNull()
  })
})

describe('SessionCache', () => {
  let tmpDir: string

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    } catch {}
  })

  it('peut être instancié', () => {
    const cache = new SessionCache()
    expect(cache).toBeDefined()
  })

  it('save() et load() fonctionnent', () => {
    tmpDir = makeTempDir()
    const cache = new SessionCache()
    cache.save(SESSION_MESSAGES, tmpDir)
    const result = cache.load(tmpDir)
    expect(result).not.toBeNull()
  })

  it('load() retourne null si rien n\'a été sauvegardé', () => {
    tmpDir = makeTempDir()
    const cache = new SessionCache()
    expect(cache.load(tmpDir)).toBeNull()
  })
})
