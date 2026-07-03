/**
 * Calibration passive : le ratio estimé/mesuré accumulé corrige les facteurs
 * de comptage sans passage manuel par `cork-ai calibrate`.
 */
import { describe, expect, it, beforeEach } from 'vitest'
import fs from 'fs'
import {
  CALIBRATION_FILE,
  getCalibrationFactor,
  recordPassiveSample,
  reloadCalibration,
} from '../../src/core/tokenizer.js'

function clearCalibration(): void {
  try { fs.unlinkSync(CALIBRATION_FILE) } catch { /* absent */ }
  reloadCalibration()  // le cache mémoire survivrait à la suppression du fichier
}

describe('calibration passive', () => {
  beforeEach(() => {
    clearCalibration()
  })

  it('ignore les facteurs passifs sous le minimum d\'échantillons', () => {
    recordPassiveSample('claude-opus-4-8', { rawEstimatedTokens: 1000, chars: 3000, measuredTokens: 1200 })
    recordPassiveSample('claude-opus-4-8', { rawEstimatedTokens: 1000, chars: 3000, measuredTokens: 1200 })
    // 2 échantillons < 3 → facteur par défaut
    expect(getCalibrationFactor('claude-opus-4-8').tiktokenFactor).toBe(1.0)
  })

  it('dérive le facteur du ratio mesuré/estimé après 3 échantillons', () => {
    for (let i = 0; i < 3; i++) {
      recordPassiveSample('claude-opus-4-8', { rawEstimatedTokens: 1000, chars: 3000, measuredTokens: 1200 })
    }
    const f = getCalibrationFactor('claude-opus-4-8')
    expect(f.tiktokenFactor).toBeCloseTo(1.2)       // 3600 / 3000
    expect(f.charsPerToken).toBeCloseTo(2.5)         // 9000 / 3600
  })

  it('accumule par famille de modèle (opus-4-8 et opus-4-7 partagent opus-new)', () => {
    for (let i = 0; i < 3; i++) {
      recordPassiveSample('claude-opus-4-8', { rawEstimatedTokens: 1000, chars: 3500, measuredTokens: 1100 })
    }
    expect(getCalibrationFactor('claude-opus-4-7').tiktokenFactor).toBeCloseTo(1.1)
  })

  it('les facteurs explicites (calibrate manuel) gagnent sur les passifs', async () => {
    const { saveCalibrationFactor } = await import('../../src/core/tokenizer.js')
    for (let i = 0; i < 5; i++) {
      recordPassiveSample('claude-haiku-4-5', { rawEstimatedTokens: 1000, chars: 3000, measuredTokens: 2000 })
    }
    saveCalibrationFactor('haiku', { tiktokenFactor: 1.15, charsPerToken: 3.2 })
    expect(getCalibrationFactor('claude-haiku-4-5').tiktokenFactor).toBe(1.15)
  })

  it('rejette les observations invalides', () => {
    recordPassiveSample('claude-opus-4-8', { rawEstimatedTokens: 0, chars: 0, measuredTokens: 0 })
    expect(getCalibrationFactor('claude-opus-4-8').tiktokenFactor).toBe(1.0)
  })
})
