import fs from 'fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CONFIG_FILE, CONFIG_KEYS, getConfigValue, installId, isTelemetryEnabled, loadConfig, parseTokens, saveConfig, setConfigValue, updateConfig } from '../../src/cli/config.js'

beforeEach(() => { try { fs.unlinkSync(CONFIG_FILE) } catch { /* none */ } })
afterEach(() => { try { fs.unlinkSync(CONFIG_FILE) } catch { /* none */ } })

describe('config', () => {
  it('parseTokens accepte 200k, 1M, 200 (milliers) et un entier', () => {
    expect(parseTokens('200k')).toBe(200_000)
    expect(parseTokens('1M')).toBe(1_000_000)
    expect(parseTokens('200')).toBe(200_000)
    expect(parseTokens('150000')).toBe(150_000)
    expect(parseTokens('abc')).toBeUndefined()
  })
  it('get/set par chemin pointé, sans muter l’original', () => {
    const cfg = { contextGuard: { enabled: true } }
    const next = setConfigValue(cfg, 'contextGuard.bands', [1, 2])
    expect(getConfigValue(next, 'contextGuard.bands')).toEqual([1, 2])
    expect(getConfigValue(next, 'contextGuard.enabled')).toBe(true)
    expect(getConfigValue(cfg, 'contextGuard.bands')).toBeUndefined()
    expect(getConfigValue(next, 'nope.deeper')).toBeUndefined()
  })
  it('les clés éditables ont un parseur qui produit le bon type', () => {
    expect(CONFIG_KEYS['contextGuard.bands'].parse('150k, 300k')).toEqual([150_000, 300_000])
    expect(CONFIG_KEYS['telemetry'].parse('true')).toBe(true)
    expect(CONFIG_KEYS['contextGuard.everyNthToolUse'].parse('7')).toBe(7)
  })
  it('updateConfig fusionne, installId est stable et aléatoire', () => {
    saveConfig({ telemetry: true })
    updateConfig({ detectedModel: 'claude-opus-5' })
    expect(loadConfig()).toEqual({ telemetry: true, detectedModel: 'claude-opus-5' })
    const id = installId()
    expect(id).toMatch(/^[0-9a-f-]{36}$/)
    expect(installId()).toBe(id)
  })
  it('isTelemetryEnabled respecte DO_NOT_TRACK et CORK_AI_TELEMETRY=0', () => {
    saveConfig({ telemetry: true })
    expect(isTelemetryEnabled()).toBe(true)
    process.env.DO_NOT_TRACK = '1'
    expect(isTelemetryEnabled()).toBe(false)
    delete process.env.DO_NOT_TRACK
    process.env.CORK_AI_TELEMETRY = '0'
    expect(isTelemetryEnabled()).toBe(false)
    delete process.env.CORK_AI_TELEMETRY
    saveConfig({})
    expect(isTelemetryEnabled()).toBe(false)
  })
})
