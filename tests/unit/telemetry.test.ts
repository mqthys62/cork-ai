import { afterEach, describe, expect, it, vi } from 'vitest'
import { POSTHOG_HOST, POSTHOG_PROJECT_TOKEN, capturePayload, contextBucket, costBucket, errorClass, installChannel, managedSettingsPresent, modelFamily, postCapture, tokenBucket } from '../../src/cli/telemetry.js'

afterEach(() => { vi.restoreAllMocks() })

describe('buckets — coarse enough to identify nothing', () => {
  it('tokens', () => {
    expect(tokenBucket(100)).toBe('<500')
    expect(tokenBucket(2_000)).toBe('1.5k-3k')
    expect(tokenBucket(50_000)).toBe('>15k')
  })
  it('context and cost', () => {
    expect(contextBucket(0)).toBe('<50k')
    expect(contextBucket(320_000)).toBe('300k-500k')
    expect(contextBucket(900_000)).toBe('>750k')
    expect(costBucket(0.5)).toBe('<$1')
    expect(costBucket(42)).toBe('$20-100')
  })
  it('model family, never the raw id', () => {
    expect(modelFamily('claude-opus-5')).toBe('opus-5')
    expect(modelFamily('claude-fable-5-1')).toBe('fable-5-1')
    expect(modelFamily('claude-haiku-4-5-20251001')).toBe('haiku-4-5')
    expect(modelFamily('gpt-x')).toBe('other')
    expect(modelFamily(undefined)).toBe('unknown')
  })
})

describe('capturePayload', () => {
  it('produit le corps attendu par PostHog /capture, sans clé undefined', () => {
    const body = capturePayload({ event: 'hook_read', properties: { decision: 'outline', ext: '.ts', maybe: undefined } }, 'install-uuid', new Date('2026-09-09T10:00:00Z'))
    expect(body.api_key).toBe(POSTHOG_PROJECT_TOKEN)
    expect(body.event).toBe('hook_read')
    expect(body.distinct_id).toBe('install-uuid')
    expect(body.timestamp).toBe('2026-09-09T10:00:00.000Z')
    const props = body.properties as Record<string, unknown>
    expect(props).toMatchObject({ $lib: 'cork-ai', decision: 'outline', ext: '.ts', os: process.platform })
    expect(props.version).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/)
    expect('maybe' in props).toBe(false)
  })
  it('porte le profil de l’installation ($set / $set_once) et fusionne celui de l’événement', () => {
    const body = capturePayload({ event: 'savings_snapshot', properties: { reason: 'gain' }, set: { lifetime_saved_tokens: 12, skip: undefined }, setOnce: { first_seen: '2026-01-01T00:00:00Z' } }, 'id')
    const props = body.properties as { $set: Record<string, unknown>; $set_once: Record<string, unknown>; runtime: string }
    expect(props.$set).toMatchObject({ version: expect.stringMatching(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/), os: process.platform, arch: process.arch, lifetime_saved_tokens: 12, telemetry: expect.any(Boolean) })
    expect('skip' in props.$set).toBe(false)
    expect(props.$set_once).toMatchObject({ first_seen: '2026-01-01T00:00:00Z', first_version: expect.any(String) })
    expect(props.runtime).toMatch(/^(node|bun)-\d+$/)
    // the enterprise signal is a boolean, never the file's content
    expect(props.$set.managed_settings).toEqual(expect.any(Boolean))
  })
})

describe('what leaves the machine about errors and setup', () => {
  it('errorClass : la classe et le code, jamais le message (qui peut citer un chemin)', () => {
    const enoent = Object.assign(new Error('ENOENT: no such file, open /home/x/secret.ts'), { code: 'ENOENT' })
    expect(errorClass(enoent)).toEqual({ error: 'Error', code: 'ENOENT' })
    expect(errorClass(new TypeError('Cannot read /home/x'))).toEqual({ error: 'TypeError', code: undefined })
    expect(errorClass('boom')).toEqual({ error: 'string' })
    expect(JSON.stringify(errorClass(enoent))).not.toContain('secret')
  })
  it('installChannel : une valeur de la liste fixe, tout le reste devient manual', () => {
    const before = process.env.CORK_AI_INSTALLER
    try {
      process.env.CORK_AI_INSTALLER = 'sh'; expect(installChannel()).toBe('sh')
      process.env.CORK_AI_INSTALLER = 'ps1'; expect(installChannel()).toBe('ps1')
      process.env.CORK_AI_INSTALLER = '/home/x/evil'; expect(installChannel()).toBe('manual')
      delete process.env.CORK_AI_INSTALLER; expect(installChannel()).toBe('manual')
    } finally { if (before === undefined) delete process.env.CORK_AI_INSTALLER; else process.env.CORK_AI_INSTALLER = before }
  })
  it('managedSettingsPresent : un booléen, sans lever', () => {
    expect(typeof managedSettingsPresent()).toBe('boolean')
  })
})

describe('postCapture', () => {
  it('poste en JSON sur <host>/capture/ et renvoie ok', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => { calls.push({ url, init }); return { ok: true } as Response })
    expect(await postCapture({ event: 'x' }, POSTHOG_HOST)).toBe(true)
    expect(calls[0].url).toBe('https://eu.i.posthog.com/capture/')
    expect(calls[0].init.method).toBe('POST')
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ event: 'x' })
  })
  it('ne lève jamais : erreur réseau → false', async () => {
    vi.stubGlobal('fetch', async () => { throw new Error('offline') })
    expect(await postCapture({ event: 'x' })).toBe(false)
  })
})
