/**
 * Outline — the compressed view the hook serves instead of a whole file.
 *
 * The previous "signatures extracted" view kept every `const`/`let` line in
 * the file (local variables included, each followed by `// ...`) and carried
 * no line numbers. The model could not target a follow-up read, so it re-read
 * the whole file: 72–81% of compressed reads were followed by a full re-read.
 *
 * This view is a navigable table of contents: one line per structural
 * declaration, prefixed with its 1-based line number, so the model can ask for
 * exactly the region it needs (`Read offset/limit`, `sed -n 'a,bp'`).
 */

import path from 'path'

export const OUTLINE_MARKER = '[cork-ai]'

/** Languages whose class members are indented method definitions with a brace body. */
const BRACE_METHOD_EXTS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.java', '.cs', '.cpp', '.c', '.h', '.hpp',
  '.swift', '.kt', '.scala', '.php', '.go', '.rs', '.dart',
  '.vue', '.svelte', '.zig',
])

const IMPORT_RE = /^(import\b|export\s+.*\bfrom\b|from\s+\S+\s+import\b|require\(|use\s+[\w:]+;|#include\b|package\s+\w|using\s+[\w.]+;)/

/** Top-level declarations across the supported languages. */
const TOP_LEVEL_RE = new RegExp([
  // JS/TS
  String.raw`^(export\s+)?(default\s+)?(declare\s+)?(abstract\s+)?(async\s+)?(function\*?|class|interface|type|enum|namespace|module)\s+[\w$]`,
  String.raw`^(export\s+)?(const|let|var)\s+[\w$]+(\s*:\s*[^=]+)?\s*=\s*(async\s+)?(\([^)]*\)|[\w$]+)\s*(:\s*[^=]+)?=>`, // arrow functions
  String.raw`^(export\s+)?(const|let|var)\s+[\w$]+\s*(:\s*[^=]+)?=\s*(new\s+\w|\{|\[|require\(|z\.|createSlice|defineComponent|defineStore|styled)`,
  // Any module-level binding is worth one line: the old view's problem was
  // *indented* consts (locals), never top-level ones.
  String.raw`^(export\s+)?(const|let|var)\s+[\w$]`,
  String.raw`^module\.exports\b|^exports\.\w+\s*=`,
  // Python
  String.raw`^(async\s+)?def\s+\w|^class\s+\w|^@\w`,
  String.raw`^[A-Z][A-Z0-9_]{2,}\s*(:\s*[^=]+)?=`, // module-level constants
  // Go
  String.raw`^func\s|^type\s+\w+\s+(struct|interface)\b|^var\s+\w|^const\s+\w|^var\s*\(|^const\s*\(`,
  // Rust
  String.raw`^(pub(\([^)]*\))?\s+)?(async\s+)?(fn|struct|enum|trait|impl|mod|type|const|static)\b`,
  String.raw`^#\[`,
  // Java / C# / Kotlin / Swift / PHP / Dart / Scala
  String.raw`^(public|private|protected|internal|open|final|abstract|sealed|static|data|object)\s+(\w+\s+)*(class|interface|enum|struct|record|object|fun|func|function|void|[\w<>\[\]?]+\s+\w+\s*\()`,
  String.raw`^(class|interface|enum|struct|protocol|extension|trait|object|record)\s+\w`,
  String.raw`^(fun|func|function)\s+\w`,
  // C / C++
  String.raw`^(static\s+|inline\s+|extern\s+)*(unsigned\s+|const\s+)*[\w:<>*&]+\s+\**\w+\s*\([^;]*$`,
  String.raw`^(typedef|template|namespace|struct|union)\b|^#define\s+\w`,
  // Ruby / Elixir / Lua
  String.raw`^(module|class|def|defmodule|defp?|defmacro)\s+\w|^(local\s+)?function\s+[\w.:]+|^[\w.]+\s*=\s*function\b`,
  // SQL
  String.raw`^(CREATE|ALTER|DROP)\s+(OR\s+REPLACE\s+)?(TABLE|VIEW|INDEX|FUNCTION|PROCEDURE|TRIGGER|TYPE|SCHEMA)\b`,
  // Shell
  String.raw`^(function\s+)?[\w-]+\s*\(\)\s*\{?`,
].map(r => `(?:${r})`).join('|'))

/** Indented members worth listing: methods, properties with functions, nested classes. */
const MEMBER_RE = new RegExp([
  // method with a brace body: `  async foo(a: string): Promise<void> {`
  String.raw`^\s{1,8}(public|private|protected|static|readonly|abstract|override|async|get|set|export|final|virtual)?\s*(static\s+)?(async\s+)?(get\s+|set\s+)?[\w$]+\s*(<[^>]*>)?\s*\([^)]*\)\s*(:\s*[^{;=]+)?\s*\{\s*$`,
  // abstract / interface member: `  foo(a: string): void` — a return type, no body, no semicolon-terminated call
  String.raw`^\s{1,8}(public|private|protected|abstract|readonly|static)?\s*[\w$]+\s*(<[^>]*>)?\s*\([^)]*\)\s*:\s*[\w<>\[\]|&,.\s'"]+;?\s*$`,
  // arrow property: `  handle = async (e) => {`
  String.raw`^\s{1,8}(public|private|protected|static|readonly|async)?\s*[\w$]+\s*(:\s*[^=]+)?=\s*(async\s+)?\([^)]*\)\s*(:\s*[^=]+)?=>`,
  String.raw`^\s{1,8}(async\s+)?def\s+\w`, // python method
  String.raw`^\s{1,8}(pub(\([^)]*\))?\s+)?(async\s+)?fn\s+\w`, // rust method
  String.raw`^\s{1,8}(public|private|protected|internal|static|override|open|final|abstract|suspend)\s+(\w+\s+)*[\w<>\[\]?]+\s+\w+\s*\(`, // java/kotlin/c#
  String.raw`^\s{1,8}(fun|func)\s+\w`,
  String.raw`^\s{1,8}(class|interface|enum|struct)\s+\w`,
  String.raw`^\s{1,8}@\w+`, // decorators
].map(r => `(?:${r})`).join('|'))

/** Section banners developers leave in code: `// ─── Name ───`, `// #region`, `# --- Name ---`. */
const SECTION_RE = /^\s*(\/\/|#|--|\/\*)\s*(─{3,}|-{3,}|={3,}|#region\b|MARK:|region\b)/

const CALL_LIKE_RE = /^\s*(if|for|while|switch|return|else|catch|try|do|await|console|expect|it|describe|test|new)\b/

export interface OutlineResult {
  text: string
  /** Structural entries listed (excluding header/hints). */
  entries: number
  /** Total lines in the source. */
  lines: number
}

function fmtLine(n: number, width: number, text: string, max = 140): string {
  const t = text.length > max ? text.slice(0, max - 1) + '…' : text
  return `L${String(n).padStart(width)}  ${t}`
}

function hint(filePath: string, lines: number): string {
  return [
    `${OUTLINE_MARKER} To view a region: Read with offset=<line> limit=<n>, or \`sed -n '<a>,<b>p' ${filePath}\`.`,
    `${OUTLINE_MARKER} Re-reading the whole file serves it raw (${lines} lines). Edit with an exact old_string only after viewing that region.`,
  ].join('\n')
}

/** Code files: imports folded, declarations with line numbers. */
export function outlineCode(content: string, filePath: string): OutlineResult {
  const ext = path.extname(filePath).toLowerCase()
  const lines = content.split(/\r?\n/)
  const width = String(lines.length).length
  const out: string[] = []
  let entries = 0

  let importCount = 0
  let firstImport = 0
  let lastImport = 0
  let pendingDecorators: string[] = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const trimmed = line.trim()
    if (trimmed === '') continue
    const n = i + 1

    if (IMPORT_RE.test(trimmed) && !/^export\s+(default\s+)?(function|class|const|let|var|interface|type|enum)/.test(trimmed)) {
      importCount++
      if (!firstImport) firstImport = n
      lastImport = n
      continue
    }

    if (SECTION_RE.test(line)) {
      out.push('')
      out.push(fmtLine(n, width, trimmed.replace(/[─=-]{3,}/g, '').replace(/\s+/g, ' ').trim()))
      entries++
      continue
    }

    const indent = line.length - line.trimStart().length
    const isTop = indent === 0 && TOP_LEVEL_RE.test(trimmed) && !CALL_LIKE_RE.test(trimmed)
    const isMember = indent > 0 && MEMBER_RE.test(line) && !CALL_LIKE_RE.test(trimmed)
    const isDecorator = /^@\w/.test(trimmed) || (ext === '.rs' && /^#\[/.test(trimmed))

    if (isDecorator && (isTop || isMember)) {
      pendingDecorators.push(fmtLine(n, width, line.trimEnd()))
      continue
    }
    if (!isTop && !isMember) continue
    if (isMember && !BRACE_METHOD_EXTS.has(ext) && !/^\s+(def|fn|fun|func|@)/.test(line)) continue

    for (const d of pendingDecorators) out.push(d)
    pendingDecorators = []

    // Keep the signature only: drop the body that may follow on the same line.
    let sig = line.trimEnd()
    // Multi-line parameter lists: pull the continuation in, up to the closing paren.
    if (/[(,]\s*$/.test(sig)) {
      for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
        sig += ' ' + lines[j].trim()
        if (/\)/.test(lines[j])) break
      }
      sig = sig.replace(/\s+/g, ' ')
    }
    // The body opens after the parameter list closes; a `{` before the last
    // `)` belongs to a destructured parameter or an object type, not the body.
    const lastParen = sig.lastIndexOf(')')
    const bodyBrace = sig.indexOf('{', lastParen + 1)
    if (bodyBrace > 0) sig = sig.slice(0, bodyBrace).trimEnd()
    else if (lastParen < 0 && /\{\s*$/.test(sig)) sig = sig.replace(/\s*\{\s*$/, '')
    if (/=>\s*.+/.test(sig) && !/=>\s*$/.test(sig)) sig = sig.replace(/=>\s*.+$/, '=> …')
    else if (/=>\s*$/.test(sig)) sig = `${sig} …`
    out.push(fmtLine(n, width, sig))
    entries++
  }

  const header = `${OUTLINE_MARKER} ${path.basename(filePath)} — ${lines.length} lines → outline (${entries} entries)`
  const imports = importCount > 0
    ? `L${String(firstImport).padStart(width)}–${lastImport}  ${importCount} import line${importCount > 1 ? 's' : ''}`
    : ''
  const body = [imports, ...out].filter((l, i, arr) => !(l === '' && (i === 0 || arr[i - 1] === ''))).join('\n')
  return { text: `${header}\n${hint(filePath, lines.length)}\n\n${body}`.trimEnd(), entries, lines: lines.length }
}

/** Markdown and prose: headings with line numbers, plus the opening lines. */
export function outlineText(content: string, filePath: string): OutlineResult {
  const lines = content.split(/\r?\n/)
  const width = String(lines.length).length
  const ext = path.extname(filePath).toLowerCase()
  const out: string[] = []
  let entries = 0

  const headingRe = /^(#{1,6})\s+\S/
  const isMarkdown = ext === '.md' || ext === '.mdx' || ext === '.rst' || ext === '.adoc' || ext === '.txt'
  const HEAD = 12

  for (let i = 0; i < Math.min(HEAD, lines.length); i++) {
    if (lines[i].trim() !== '') out.push(fmtLine(i + 1, width, lines[i].trimEnd()))
  }
  if (out.length > 0) out.push('')

  if (isMarkdown) {
    let inFence = false
    for (let i = HEAD; i < lines.length; i++) {
      const line = lines[i]
      if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; continue }
      if (inFence) continue
      if (headingRe.test(line) || /^\s*-\s*\[[ x]\]\s+/i.test(line) && entries < 40) {
        out.push(fmtLine(i + 1, width, line.trimEnd()))
        entries++
      }
    }
  } else {
    // css/scss/html/yaml/…: rule selectors, top-level keys, tags with ids.
    const structural = /^(?:[.#@:\w][^{};]*\{\s*$|[\w-]+:\s*$|<(?:section|div|main|header|footer|nav|form|table|article|aside|template|script|style)\b[^>]*\bid=|\[[\w.-]+\]\s*$|\w[\w.-]*\s*=\s*$)/
    for (let i = HEAD; i < lines.length; i++) {
      const line = lines[i]
      if (structural.test(line.trim()) && (line.length - line.trimStart().length) <= 2) {
        out.push(fmtLine(i + 1, width, line.trimEnd()))
        entries++
      }
    }
  }

  const header = `${OUTLINE_MARKER} ${path.basename(filePath)} — ${lines.length} lines → outline (${entries} entries)`
  return { text: `${header}\n${hint(filePath, lines.length)}\n\n${out.join('\n')}`.trimEnd(), entries, lines: lines.length }
}

/** JSON: keys kept, long strings and arrays elided. */
export function outlineJson(content: string, filePath: string): OutlineResult {
  const lines = content.split(/\r?\n/).length
  try {
    const obj = JSON.parse(content) as unknown
    const slim = JSON.stringify(obj, (_k, v) => {
      if (typeof v === 'string' && v.length > 120) return v.slice(0, 120) + '…'
      if (Array.isArray(v) && v.length > 12) return [...v.slice(0, 12), `… (${v.length - 12} more)`]
      return v
    }, 2)
    const header = `${OUTLINE_MARKER} ${path.basename(filePath)} — ${lines} lines → JSON with long values elided`
    return { text: `${header}\n${hint(filePath, lines)}\n\n${slim}`, entries: 1, lines }
  } catch {
    return outlineText(content, filePath)
  }
}

export type OutlineKind = 'code' | 'json' | 'text'

export function outline(content: string, filePath: string, kind: OutlineKind): OutlineResult {
  if (kind === 'code') return outlineCode(content, filePath)
  if (kind === 'json') return outlineJson(content, filePath)
  return outlineText(content, filePath)
}
