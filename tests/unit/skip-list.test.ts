import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

// skip-list reads CORK_AI_HOME at module load, so each test gets a private
// directory and re-imports the module through vi.resetModules().
let HOME: string
let previousHome: string | undefined
let mod: typeof import('../../src/cli/skip-list.js')

beforeEach(async () => {
  HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'cork-skiplist-'))
  previousHome = process.env.CORK_AI_HOME
  process.env.CORK_AI_HOME = HOME
  vi.resetModules()
  mod = await import('../../src/cli/skip-list.js')
})

afterEach(() => {
  if (previousHome === undefined) delete process.env.CORK_AI_HOME
  else process.env.CORK_AI_HOME = previousHome
  fs.rmSync(HOME, { recursive: true, force: true })
})

describe('skip-list', () => {
  it("ne connaît rien au départ", () => {
    expect(mod.isSkipped('/a/b.ts')).toBe(false)
    expect(mod.skippedCount()).toBe(0)
  })

  it('retient un fichier re-lu, y compris après rechargement du module', async () => {
    mod.markSkipped('/a/b.ts', 're-read')
    expect(mod.isSkipped('/a/b.ts')).toBe(true)

    // Simule une nouvelle session : le module est rechargé, le disque persiste.
    vi.resetModules()
    const reloaded = await import('../../src/cli/skip-list.js')
    expect(reloaded.isSkipped('/a/b.ts')).toBe(true)
  })

  it("n'affecte pas les autres fichiers", () => {
    mod.markSkipped('/a/b.ts', 're-read')
    expect(mod.isSkipped('/a/autre.ts')).toBe(false)
  })

  it('accumule les preuves sans dupliquer', () => {
    mod.markSkipped('/a/b.ts', 're-read')
    mod.markSkipped('/a/b.ts', 'edit-failure')
    expect(mod.skippedCount()).toBe(1)
  })

  it('expire une entrée de plus de 30 jours', () => {
    mod.markSkipped('/a/b.ts', 're-read')
    const file = path.join(HOME, 'skip-list.json')
    const list = JSON.parse(fs.readFileSync(file, 'utf-8'))
    list.files['/a/b.ts'].at = new Date(Date.now() - 31 * 24 * 3600 * 1000).toISOString()
    fs.writeFileSync(file, JSON.stringify(list), 'utf-8')

    expect(mod.isSkipped('/a/b.ts')).toBe(false)
    expect(mod.skippedCount()).toBe(0)
  })

  it('survit à un fichier corrompu', () => {
    fs.writeFileSync(path.join(HOME, 'skip-list.json'), 'pas du json', 'utf-8')
    expect(mod.isSkipped('/a/b.ts')).toBe(false)
    expect(() => mod.markSkipped('/a/b.ts', 're-read')).not.toThrow()
    expect(mod.isSkipped('/a/b.ts')).toBe(true)
  })
})
