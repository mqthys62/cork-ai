import { describe, it, expect } from 'vitest'
import { eligibility, looksBinary } from '../../src/cli/file-eligibility.js'

/** Real 1×1 PNG — header, IHDR, IDAT and IEND, NUL bytes included. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

const text = (s: string): Buffer => Buffer.from(s, 'utf-8')

describe('looksBinary', () => {
  it('détecte un vrai PNG', () => {
    expect(looksBinary(PNG)).toBe(true)
  })

  it('accepte du code utf-8 avec accents', () => {
    expect(looksBinary(text('const café = "déjà vu";\n// où ça ?\n'))).toBe(false)
  })

  it('accepte un fichier vide', () => {
    expect(looksBinary(Buffer.alloc(0))).toBe(false)
  })

  it('rejette au premier octet NUL', () => {
    expect(looksBinary(Buffer.from([0x68, 0x69, 0x00, 0x68]))).toBe(true)
  })

  it('tolère tabulations, retours ligne et form feed', () => {
    expect(looksBinary(text('a\tb\r\nc\fd\n'))).toBe(false)
  })
})

describe('eligibility', () => {
  it("refuse un PNG — c'était la régression : Read en utf-8 ne lève pas d'erreur", () => {
    const verdict = eligibility('/tmp/shot.png', PNG)
    expect(verdict.compress).toBe(false)
    expect(verdict).toMatchObject({ reason: expect.stringContaining('binary') })
  })

  it("refuse un binaire même si l'extension ment", () => {
    const verdict = eligibility('/tmp/actually-an-image.ts', PNG)
    expect(verdict.compress).toBe(false)
    expect(verdict).toMatchObject({ reason: 'binary content' })
  })

  it('accepte le code connu', () => {
    expect(eligibility('/tmp/a.ts', text('export const a = 1\n'))).toEqual({ compress: true, kind: 'code' })
    expect(eligibility('/tmp/a.luau', text('local x = 1\n'))).toEqual({ compress: true, kind: 'code' })
  })

  it('accepte le JSON', () => {
    expect(eligibility('/tmp/a.json', text('{"a":1}'))).toEqual({ compress: true, kind: 'json' })
  })

  it('accepte la prose et le markup listés', () => {
    expect(eligibility('/tmp/a.md', text('# Titre\n'))).toEqual({ compress: true, kind: 'text' })
    expect(eligibility('/tmp/a.css', text('a{color:red}\n'))).toEqual({ compress: true, kind: 'text' })
  })

  it("s'abstient sur une extension inconnue plutôt que de tronquer", () => {
    // L'ancien catch-all envoyait tout sur compressText : c'est ce qui donnait
    // les pires taux de re-lecture.
    const verdict = eligibility('/tmp/archive.weirdext', text('hello\n'))
    expect(verdict.compress).toBe(false)
  })

  it("s'abstient sur un fichier sans extension", () => {
    expect(eligibility('/tmp/Makefile', text('all:\n\techo hi\n')).compress).toBe(false)
  })

  it('refuse les types binaires listés sans même regarder le contenu', () => {
    for (const p of ['/a/x.pdf', '/a/x.zip', '/a/x.woff2', '/a/x.mp4', '/a/x.sqlite']) {
      expect(eligibility(p, text('not actually binary')).compress).toBe(false)
    }
  })
})
