import { describe, expect, it } from 'vitest'
import { OUTLINE_MARKER, outline, outlineCode, outlineText } from '../../src/cli/outline.js'

const TS = `import fs from 'fs'
import path from 'path'

// ─── Helpers ───────────────────────────────

export interface Options {
  retries: number
}

const DEFAULT_RETRIES = 3

export async function fetchAll(urls: string[], options: Options = { retries: DEFAULT_RETRIES }): Promise<string[]> {
  const results: string[] = []
  for (const url of urls) {
    const body = await fetch(url)
    results.push(String(body))
  }
  return results
}

export class Cache {
  private store = new Map<string, string>()

  get(key: string): string | undefined {
    const hit = this.store.get(key)
    return hit
  }

  async set(key: string, value: string): Promise<void> {
    this.store.set(key, value)
  }
}

export const handler = async (event: { id: string }) => {
  return event.id
}

function multiline(
  a: string,
  b: number,
): void {
  console.log(a, b)
}
`

describe('outlineCode', () => {
  const out = outlineCode(TS, '/proj/src/lib.ts')

  it('porte le marqueur, le nombre de lignes et le hint offset/limit', () => {
    expect(out.text.startsWith(`${OUTLINE_MARKER} lib.ts — `)).toBe(true)
    expect(out.text).toContain('offset=<line> limit=<n>')
    expect(out.text).toContain("sed -n '<a>,<b>p' /proj/src/lib.ts")
    expect(out.lines).toBe(TS.split('\n').length)
  })

  it('numérote chaque déclaration de premier niveau avec sa ligne réelle', () => {
    const lines = TS.split('\n')
    const lineOf = (needle: string) => lines.findIndex(l => l.includes(needle)) + 1
    expect(out.text).toContain(`L${String(lineOf('export interface Options')).padStart(2)}  export interface Options`)
    expect(out.text).toContain(`L${String(lineOf('export async function fetchAll')).padStart(2)}  export async function fetchAll(urls: string[], options: Options = { retries: DEFAULT_RETRIES }): Promise<string[]>`)
    expect(out.text).toContain(`L${String(lineOf('export class Cache')).padStart(2)}  export class Cache`)
  })

  it('replie les imports en un compteur', () => {
    expect(out.text).toContain('2 import lines')
    expect(out.text).not.toContain("import fs from 'fs'")
  })

  it('liste les méthodes de classe mais pas les instructions locales', () => {
    expect(out.text).toContain('get(key: string): string | undefined')
    expect(out.text).toContain('async set(key: string, value: string): Promise<void>')
    expect(out.text).not.toContain('const hit = ')
    expect(out.text).not.toContain('results.push')
    expect(out.text).not.toContain('// ...')
  })

  it('garde les constantes de module et les fonctions fléchées, sans leur corps', () => {
    expect(out.text).toContain('const DEFAULT_RETRIES = 3')
    expect(out.text).toContain('export const handler = async (event: { id: string }) => …')
    expect(out.text).not.toContain('return event.id')
  })

  it('recolle une signature multi-lignes', () => {
    expect(out.text).toContain('function multiline( a: string, b: number, ): void')
  })

  it('conserve les bannières de section', () => {
    expect(out.text).toContain('// Helpers')
  })

  it('compresse (hors en-tête fixe de 3 lignes) et liste au moins 7 entrées', () => {
    const body = out.text.split('\n').slice(3).join('\n')
    expect(body.length).toBeLessThan(TS.length * 0.6) // tiny, declaration-dense sample; real files measure 85–90%
    expect(out.entries).toBeGreaterThanOrEqual(7)
  })
})

describe('outlineCode — autres langages', () => {
  it('python : def / class / constantes', () => {
    const py = `import os\n\nDB_PATH = os.path.join("a", "b")\n\nclass Store:\n    def __init__(self):\n        self.x = 1\n\n    def get(self, key):\n        return key\n\ndef helper(a, b=2):\n    return a + b\n`
    const out = outlineCode(py, '/p/store.py')
    expect(out.text).toContain('L 3  DB_PATH = os.path.join("a", "b")')
    expect(out.text).toContain('L 5  class Store:')
    expect(out.text).toContain('L 9      def get(self, key):')
    expect(out.text).toContain('L12  def helper(a, b=2):')
    expect(out.text).not.toContain('self.x = 1')
  })
  it('go : func et type struct', () => {
    const go = `package main\n\nimport "fmt"\n\ntype Server struct {\n\tPort int\n}\n\nfunc (s *Server) Start() error {\n\treturn nil\n}\n\nfunc main() {\n\tfmt.Println("x")\n}\n`
    const out = outlineCode(go, '/p/main.go')
    expect(out.text).toContain('type Server struct')
    expect(out.text).toContain('func (s *Server) Start() error')
    expect(out.text).toContain('func main()')
    expect(out.text).not.toContain('fmt.Println')
  })
})

describe('outlineText', () => {
  it('markdown : ouverture + titres numérotés, blocs de code ignorés', () => {
    const md = `# Title\n\nIntro line.\n\n${'filler\n'.repeat(12)}## Setup\n\n\`\`\`bash\n# not a heading\n\`\`\`\n\n### Details\n`
    const out = outlineText(md, '/p/README.md')
    expect(out.text).toContain('L 1  # Title')
    expect(out.text).toMatch(/L\d+  ## Setup/)
    expect(out.text).toMatch(/L\d+  ### Details/)
    expect(out.text).not.toContain('# not a heading')
    expect(out.entries).toBe(2)
  })
})

describe('outline (dispatch)', () => {
  it('json : clés gardées, longues valeurs élidées', () => {
    const json = JSON.stringify({ name: 'x', big: 'y'.repeat(500), list: Array.from({ length: 30 }, (_, i) => i) }, null, 2)
    const out = outline(json, '/p/data.json', 'json')
    expect(out.text).toContain('"name": "x"')
    expect(out.text).toContain('…')
    expect(out.text).toContain('(18 more)')
    expect(out.text.length).toBeLessThan(json.length)
  })
})
