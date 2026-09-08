import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parseBashEdit, parseBashRead, splitWords } from '../../src/cli/bash-read.js'

let dir: string
let file: string

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cork-bash-read-'))
  file = path.join(dir, 'app.ts')
  fs.writeFileSync(file, 'export const a = 1\n')
  fs.mkdirSync(path.join(dir, 'src'))
  fs.writeFileSync(path.join(dir, 'src', 'b.ts'), 'export const b = 2\n')
})

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('splitWords', () => {
  it('honore les guillemets simples et doubles', () => {
    expect(splitWords(`sed -n '10,20p' "my file.ts"`)).toEqual(['sed', '-n', '10,20p', 'my file.ts'])
  })
  it('refuse les guillemets non fermés', () => {
    expect(splitWords(`cat 'oops`)).toBeUndefined()
  })
})

describe('parseBashRead — lectures entières', () => {
  it('cat fichier → full, chemin résolu depuis cwd', () => {
    expect(parseBashRead('cat app.ts', dir)).toEqual({ kind: 'full', file, tool: 'cat' })
    expect(parseBashRead('cat src/b.ts', dir)?.file).toBe(path.join(dir, 'src', 'b.ts'))
  })
  it('cat -n, cat -A et le chemin absolu sont acceptés', () => {
    expect(parseBashRead(`cat -n ${file}`, '/')?.kind).toBe('full')
    expect(parseBashRead(`cat -A "${file}"`, '/')?.kind).toBe('full')
  })
  it('rtk proxy cat est une lecture', () => {
    expect(parseBashRead('rtk proxy cat app.ts', dir)?.kind).toBe('full')
  })
  it('nl / bat / less comptent comme lecture entière', () => {
    expect(parseBashRead('nl app.ts', dir)?.kind).toBe('full')
    expect(parseBashRead('bat -p app.ts', dir)?.kind).toBe('full')
  })
  it('refuse pipes, redirections, chaînages et substitutions', () => {
    for (const cmd of ['cat app.ts | head -20', 'cat app.ts > out.txt', 'cat app.ts && ls', 'cat app.ts; ls', 'cat $(ls)', 'cat `ls`', 'cat app.ts 2>&1']) {
      expect(parseBashRead(cmd, dir), cmd).toBeUndefined()
    }
  })
  it('refuse plusieurs fichiers, stdin, un fichier absent ou un répertoire', () => {
    expect(parseBashRead('cat app.ts src/b.ts', dir)).toBeUndefined()
    expect(parseBashRead('cat -', dir)).toBeUndefined()
    expect(parseBashRead('cat missing.ts', dir)).toBeUndefined()
    expect(parseBashRead('cat src', dir)).toBeUndefined()
  })
  it('refuse une option cat inconnue (ex. --help) et une affectation préalable', () => {
    expect(parseBashRead('cat --help app.ts', dir)).toBeUndefined()
    expect(parseBashRead('FOO=1 cat app.ts', dir)).toBeUndefined()
  })
})

describe('parseBashRead — lectures ciblées', () => {
  it("sed -n 'a,bp' fichier → range", () => {
    expect(parseBashRead(`sed -n '10,40p' app.ts`, dir)).toEqual({ kind: 'range', file, tool: 'sed' })
    expect(parseBashRead(`sed -n 10,40p app.ts`, dir)?.kind).toBe('range')
  })
  it('sed sans -n (transformation) n’est pas une lecture', () => {
    expect(parseBashRead(`sed 's/a/b/' app.ts`, dir)).toBeUndefined()
  })
  it('head / tail avec -n ou -N → range', () => {
    expect(parseBashRead('head -n 50 app.ts', dir)?.kind).toBe('range')
    expect(parseBashRead('head -50 app.ts', dir)?.kind).toBe('range')
    expect(parseBashRead('tail -n 20 app.ts', dir)?.kind).toBe('range')
    expect(parseBashRead('tail -c 200 app.ts', dir)?.kind).toBe('range')
  })
  it('awk n’est pas reconnu (programme entre quotes avec && : trop ambigu)', () => {
    expect(parseBashRead(`awk 'NR>=10 && NR<=20' app.ts`, dir)).toBeUndefined()
  })
})

describe('parseBashEdit', () => {
  it('sed -i sur un fichier', () => {
    expect(parseBashEdit(`sed -i 's/a/b/' app.ts`, dir)?.file).toBe(file)
    expect(parseBashEdit(`sed -i.bak -e 's/a/b/' app.ts`, dir)?.tool).toBe('sed -i')
  })
  it('redirection et heredoc vers un fichier existant', () => {
    expect(parseBashEdit(`cat > app.ts <<'EOF'\nx\nEOF`, dir)?.file).toBe(file)
    expect(parseBashEdit(`echo hi >> app.ts`, dir)?.tool).toBe('redirect')
    expect(parseBashEdit(`printf x | tee app.ts`, dir)?.tool).toBe('tee')
  })
  it('ignore /dev/null, 2>&1 et les fichiers absents', () => {
    expect(parseBashEdit('cmd > /dev/null 2>&1', dir)).toBeUndefined()
    expect(parseBashEdit('cmd > nope.txt', dir)).toBeUndefined()
    expect(parseBashEdit('cat app.ts', dir)).toBeUndefined()
  })
})
