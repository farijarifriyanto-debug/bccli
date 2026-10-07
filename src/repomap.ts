import { readdirSync, readFileSync } from 'node:fs'
import { extname, join, relative, sep } from 'node:path'
import { estimateTokens } from './tokenBudget'

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '.next',
  'target',
  'vendor',
  '__pycache__',
  '.venv',
  '.cache',
])
const CODE_EXTS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.go',
  '.rs',
  '.java',
  '.c',
  '.h',
  '.cpp',
  '.hpp',
  '.cs',
  '.rb',
  '.php',
  '.sh',
  '.ps1',
])
const MAX_FILES = 400
const MAX_FILE_BYTES = 200_000
const MAX_SYMBOLS_PER_FILE = 12

const FAMILY: Record<string, RegExp[]> = {
  ts: [
    /^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function|class|interface|type|enum)\s+([A-Za-z0-9_$]+)/,
    /^\s*export\s+(?:const|let)\s+([A-Za-z0-9_$]+)/,
  ],
  py: [/^\s*(?:async\s+)?def\s+(\w+)/, /^\s*class\s+(\w+)/],
  go: [/^func\s+(?:\([^)]*\)\s*)?(\w+)/, /^type\s+(\w+)/],
  rs: [/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:unsafe\s+)?(?:async\s+)?(?:fn|struct|enum|trait|type)\s+(\w+)/],
  c: [/^\s*(?:static\s+|inline\s+|extern\s+)*[A-Za-z_][A-Za-z0-9_\s*]*\b(\w+)\s*\([^;]*\)\s*\{?\s*$/],
}

function familyFor(ext: string): RegExp[] {
  if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.java', '.cs', '.php', '.rb'].includes(ext)) return FAMILY.ts
  if (ext === '.py' || ext === '.sh' || ext === '.ps1') return FAMILY.py
  if (ext === '.go') return FAMILY.go
  if (ext === '.rs') return FAMILY.rs
  return FAMILY.c
}

/** Top-level function/class/type names of one file, capped, in source order. */
export function extractSymbols(text: string, ext: string): string[] {
  const out: string[] = []
  for (const line of text.split('\n')) {
    for (const re of familyFor(ext)) {
      const m = re.exec(line)
      if (m) {
        if (!out.includes(m[1])) out.push(m[1])
        break
      }
    }
    if (out.length >= MAX_SYMBOLS_PER_FILE) break
  }
  return out
}

function walk(dir: string, root: string, files: string[]): void {
  if (files.length >= MAX_FILES) return
  let entries: import('node:fs').Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (files.length >= MAX_FILES) return
    const full = join(dir, e.name)
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || (e.name.startsWith('.') && full !== root)) continue
      walk(full, root, files)
    } else if (e.isFile() && CODE_EXTS.has(extname(e.name).toLowerCase())) {
      files.push(full)
    }
  }
}

/**
 * Aider-style repo map: every code file (node_modules/.git excluded) with its top-level
 * symbols, shallowest paths first, cut off at a token budget. Synchronous on purpose —
 * it is computed once at boot for the system prompt.
 */
export function buildRepoMapSync(cwd: string, opts: { maxTokens?: number } = {}): string {
  const maxTokens = opts.maxTokens ?? 2048
  const files: string[] = []
  walk(cwd, cwd, files)
  files.sort(
    (a, b) =>
      relative(cwd, a).split(sep).length - relative(cwd, b).split(sep).length || a.localeCompare(b),
  )
  const lines: string[] = []
  let used = 0
  let truncated = false
  for (const file of files) {
    const rel = relative(cwd, file).split(sep).join('/')
    let symbols: string[] = []
    try {
      const text = readFileSync(file, 'utf8')
      if (text.length <= MAX_FILE_BYTES) symbols = extractSymbols(text, extname(file).toLowerCase())
    } catch {
      symbols = []
    }
    const line = symbols.length ? `${rel}: ${symbols.join(', ')}` : rel
    const cost = estimateTokens(line)
    if (used + cost > maxTokens) {
      truncated = true
      break
    }
    used += cost
    lines.push(line)
  }
  if (truncated) lines.push(`… truncated (repo map limited to ${maxTokens} tokens)`)
  return lines.join('\n')
}
