import fs from 'fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { FLUSH_AT, SPOOL_FILE, SPOOL_MAX, readSpool, spool, spoolSize, takeSpool } from '../../src/cli/telemetry-spool.js'
import { postBatch, POSTHOG_PROJECT_TOKEN } from '../../src/cli/telemetry.js'

const ev = (n: number, at?: string) => ({ event: 'hook_read', properties: { i: n }, timestamp: at ?? new Date().toISOString() })

beforeEach(() => { try { fs.unlinkSync(SPOOL_FILE) } catch { /* pas de spool */ } })
afterEach(() => { vi.restoreAllMocks(); try { fs.unlinkSync(SPOOL_FILE) } catch { /* déjà parti */ } })

describe('le spool — accumuler sans jamais casser une lecture', () => {
  it('empile et rend dans l’ordre', () => {
    spool(ev(1)); spool(ev(2)); spool(ev(3))
    expect(readSpool().map(e => e.properties?.i)).toEqual([1, 2, 3])
  })

  it('demande une vidange une fois le seuil atteint, pas avant', () => {
    for (let i = 1; i < FLUSH_AT; i++) expect(spool(ev(i))).toBe(false)
    expect(spool(ev(FLUSH_AT))).toBe(true)
  })

  it('takeSpool vide le fichier et rend tout : prendre-puis-envoyer, jamais l’inverse', () => {
    spool(ev(1)); spool(ev(2))
    expect(takeSpool()).toHaveLength(2)
    // Le doublon coûte plus cher que la perte : un événement envoyé deux fois
    // gonfle chaque compteur du dashboard.
    expect(spoolSize()).toBe(0)
    expect(takeSpool()).toEqual([])
  })

  it('un spool absent ou illisible n’est pas une erreur, c’est un spool vide', () => {
    expect(readSpool()).toEqual([])
    fs.writeFileSync(SPOOL_FILE, '{ ceci n’est pas du JSON')
    expect(readSpool()).toEqual([])
    expect(() => spool(ev(1))).not.toThrow()
    expect(readSpool()).toHaveLength(1)
  })

  it('un spool qui contient autre chose qu’un tableau est ignoré', () => {
    fs.writeFileSync(SPOOL_FILE, '{"event":"pas-un-tableau"}')
    expect(readSpool()).toEqual([])
  })
})

describe('les bornes — une semaine hors ligne ne doit pas gonfler indéfiniment', () => {
  it('plafonne à SPOOL_MAX en jetant les plus anciens', () => {
    const trop = Array.from({ length: SPOOL_MAX + 40 }, (_, i) => ev(i))
    fs.writeFileSync(SPOOL_FILE, JSON.stringify(trop))
    spool(ev(9999))
    const kept = readSpool()
    expect(kept).toHaveLength(SPOOL_MAX)
    // Ce sont les plus récents qu’on garde : le dernier ajouté doit survivre.
    expect(kept[kept.length - 1].properties?.i).toBe(9999)
    expect(kept[0].properties?.i).not.toBe(0)
  })

  it('jette ce qui est trop vieux pour vouloir dire quelque chose', () => {
    const vieux = new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString()
    fs.writeFileSync(SPOOL_FILE, JSON.stringify([ev(1, vieux), ev(2)]))
    spool(ev(3))
    expect(readSpool().map(e => e.properties?.i)).toEqual([2, 3])
  })

  it('un événement sans horodatage est gardé plutôt que jeté au hasard', () => {
    fs.writeFileSync(SPOOL_FILE, JSON.stringify([{ event: 'hook_read', properties: { i: 1 } }]))
    spool(ev(2))
    expect(readSpool()).toHaveLength(2)
  })
})

describe('postBatch — une requête pour tout le lot', () => {
  it('envoie la forme { api_key, batch } que PostHog attend', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => { calls.push({ url, init }); return { ok: true } as Response })

    await postBatch([
      { api_key: 'x', event: 'hook_read', distinct_id: 'id', properties: { a: 1 } },
      { api_key: 'x', event: 'hook_reread', distinct_id: 'id', properties: { b: 2 } },
    ])

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://eu.i.posthog.com/capture/')
    const body = JSON.parse(String(calls[0].init.body))
    expect(body.api_key).toBe(POSTHOG_PROJECT_TOKEN)
    expect(body.batch).toHaveLength(2)
    // La clé appartient à l’enveloppe : la répéter dans chaque entrée fait
    // échouer la validation de PostHog.
    expect(body.batch[0].api_key).toBeUndefined()
    expect(body.batch[0].event).toBe('hook_read')
  })

  it('un lot vide ne part pas sur le réseau', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    expect(await postBatch([])).toBe(true)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('hors ligne : rend false sans lever', async () => {
    vi.stubGlobal('fetch', async () => { throw new Error('offline') })
    expect(await postBatch([{ event: 'hook_read' }])).toBe(false)
  })
})

describe('les moments où la session respire', () => {
  it("vide au Stop et au SessionEnd, pas au milieu d'une rafale de lectures", async () => {
    const { handleHookEvent } = await import('../../src/cli/hook.js')
    const flushes: string[] = []
    const deps = { telemetry: () => {}, snapshot: () => {}, flush: () => { flushes.push('flush') } }

    handleHookEvent({ hook_event_name: 'Stop', session_id: 's1' }, deps)
    expect(flushes).toHaveLength(1)

    handleHookEvent({ hook_event_name: 'UserPromptSubmit', session_id: 's1' }, deps)
    // Claude est en train de répondre : rien ne part, la rafale continue.
    expect(flushes).toHaveLength(1)

    handleHookEvent({ hook_event_name: 'SessionEnd', session_id: 's1' }, deps)
    expect(flushes).toHaveLength(2)
  })

  it('au SessionStart, ne vide que s’il reste vraiment quelque chose', async () => {
    const { handleHookEvent } = await import('../../src/cli/hook.js')
    const flushes: string[] = []
    const deps = { telemetry: () => {}, snapshot: () => {}, flush: () => { flushes.push('flush') } }

    try { fs.unlinkSync(SPOOL_FILE) } catch { /* déjà vide */ }
    handleHookEvent({ hook_event_name: 'SessionStart', session_id: 's-neuve' }, deps)
    expect(flushes).toHaveLength(0)

    // Un reliquat d’une session qui s’est terminée hors ligne.
    spool(ev(1))
    handleHookEvent({ hook_event_name: 'SessionStart', session_id: 's-reprise' }, deps)
    expect(flushes).toHaveLength(1)
  })
})
