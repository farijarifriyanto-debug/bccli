# Fase 2 Implementation Plan — repo map, themes, vim, sandbox bash, LSP diagnostics, SDK, ACP

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tutup 7 gap paritas bccli (repo map, themes, vim mode, OS sandbox bash, LSP diagnostics dasar, SDK programatik, ACP agent server) — semua TDD, semua dirilis-TAHAN (commit lokal saja).

**Architecture:** Tiap fitur = satu modul murni baru + wiring tipis di `src/config.ts` (validasi), `src/setup.ts` (komposisi), `src/cli.ts`/`src/ui/App.tsx` (entrypoint). Pola mengikuti Fase 1: modul murni gampang di-unit-test, integrasi diverifikasi lewat canary live di Task 8.

**Tech Stack:** TypeScript ESM, ink 7 + React 19, zod 4, vitest 5, biome 2.5, tsup. Node >= 22. TANPA dependency npm baru (ACP diimplementasi langsung sebagai newline-delimited JSON-RPC).

**Spec:** Gap analysis 16 item (AGENTS.md opencode, sesi 2026-10-07) — item #2 sandbox, #3 LSP, #11 OAuth provider, #14 repo map, #15 SDK/ACP, #16 themes/vim. **Deviation yang disetujui-diam:** #11 (OAuth login provider) DITUNDA ke Fase 3 — butuh keputusan produk (provider mana yang punya OAuth publik untuk CLI); Fase 2 mengerjakan 6 item lain + SDK/ACP.

**Repo kerja:** `C:\Users\farij\AppData\Local\Temp\opencode\bccli-audit`, branch `main`, HEAD `3bd22e0`.

## Global Constraints

- DILARANG bump version / push / tag / npm publish — rilis ditahan user.
- DILARANG dependency npm baru (pin `undici@7.28.0` jangan disentuh).
- Config fitur baru = GLOBAL-ONLY (`~/.bccli/config.json` / `BCCLI_HOME`), tidak dibaca dari project config — pola `keybinds`/`verifyCommands` di `src/config.ts`.
- Setiap string yang lewat `t('...')` WAJIB punya key di `src/i18n/id.ts` (test/i18n.test.ts memaksa; tidak boleh stale).
- Suite vitest berjalan dalam bahasa Indonesia (`test/setup.ts` set 'id') — assertion jangan hardcode teks EN; pakai substring stabil (nama field config) atau `t(key)`.
- JANGAN edit file via PowerShell `Set-Content`/`Add-Content` (korupsi UTF-8) — hanya tool `edit`/`write`.
- Style: tanpa semicolon, single quote, indent 2 spasi (biome). `npm run lint` harus 0 error.
- Urutan gate tiap task: `npx vitest run <file>` → `npx tsc --noEmit -p tsconfig.json` → commit.
- UI test: `frames.at(-1)` (append-only); Esc = `String.fromCharCode(27)`.

---

### Task 1: Repo map (file + simbol, budget token)

**Files:**
- Create: `src/repomap.ts`
- Create: `src/tools/repomap.ts`
- Modify: `src/context.ts:41` (opts `repoMap?: string`)
- Modify: `src/config.ts` (field `repoMap?: boolean` + validasi)
- Modify: `src/setup.ts:139,150,180,315` (hitung map sekali, teruskan ke semua `buildSystemPrompt`)
- Test: `test/repomap.test.ts`

**Interfaces:**
- Produces: `buildRepoMapSync(cwd: string, opts?: { maxTokens?: number }): string`, `extractSymbols(text: string, ext: string): string[]`, `createRepoMapTool(): Tool` (name `repo_map`), config `repoMap?: boolean` (default `false`).
- Consumes: `estimateTokens` dari `src/tokenBudget.ts:4`.

- [ ] **Step 1: Tulis test yang gagal** — `test/repomap.test.ts`:

```ts
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildRepoMapSync, extractSymbols } from '../src/repomap'
import { createRepoMapTool } from '../src/tools/repomap'
import { buildSystemPrompt } from '../src/context'
import { loadConfig, ConfigError } from '../src/config'

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), 'bccli-map-'))
  mkdirSync(join(root, 'src'), { recursive: true })
  mkdirSync(join(root, 'node_modules', 'dep'), { recursive: true })
  writeFileSync(join(root, 'src', 'a.ts'), 'export function alpha() {}\nclass Beta {}\n')
  writeFileSync(join(root, 'lib.py'), 'def gamma():\n    pass\n')
  writeFileSync(join(root, 'node_modules', 'dep', 'x.ts'), 'export function hidden() {}\n')
  return root
}

describe('repo map', () => {
  it('lists code files with top-level symbols and skips node_modules', () => {
    const map = buildRepoMapSync(repo())
    expect(map).toContain('alpha')
    expect(map).toContain('Beta')
    expect(map).toContain('gamma')
    expect(map).not.toContain('hidden')
  })

  it('extracts symbols per language', () => {
    expect(extractSymbols('export async function f() {}\ninterface I {}\nconst g = 1\n', '.ts')).toEqual(
      expect.arrayContaining(['f', 'I']),
    )
    expect(extractSymbols('def a():\n    pass\nclass B:\n    pass\n', '.py')).toEqual(['a', 'B'])
    expect(extractSymbols('func (s *S) Do() {}\ntype T struct{}\n', '.go')).toEqual(expect.arrayContaining(['Do', 'T']))
    expect(extractSymbols('pub fn main() {}\nstruct S;\n', '.rs')).toEqual(expect.arrayContaining(['main', 'S']))
  })

  it('truncates to the token budget', () => {
    const root = repo()
    for (let i = 0; i < 40; i++) writeFileSync(join(root, 'src', `f${i}.ts`), `export function fn${i}() {}\n`)
    const map = buildRepoMapSync(root, { maxTokens: 60 })
    expect(map).toContain('truncated')
    expect(map.split('\n').length).toBeLessThan(40)
  })

  it('exposes a repo_map tool', async () => {
    const tool = createRepoMapTool()
    expect(tool.name).toBe('repo_map')
    const r = await tool.run({}, { cwd: repo(), signal: new AbortController().signal } as never)
    expect(r.output).toContain('alpha')
    expect(r.isError).toBeFalsy()
  })

  it('injects the map into the system prompt when asked', () => {
    const p = buildSystemPrompt({ cwd: '/x', home: '/h', model: 'm', repoMap: 'MAPTEXT' })
    expect(p).toContain('Repository map')
    expect(p).toContain('MAPTEXT')
  })

  it('rejects a non-boolean repoMap config', () => {
    const home = mkdtempSync(join(tmpdir(), 'bccli-mapcfg-'))
    writeFileSync(join(home, 'config.json'), JSON.stringify({ repoMap: 'yes' }))
    expect(() => loadConfig(home, { BCCLI_HOME: home } as never)).toThrow(ConfigError)
  })
})
```

Catatan: cek dulu cara test config lain membangun `loadConfig` (mis. `test/config.test.ts` — signature `loadConfig(cwd, env)` dan cara inject global config lewat `BCCLI_HOME`); samakan pola pemanggilan di test terakhir bila perlu.

- [ ] **Step 2: Jalankan, pastikan RED**

Run: `npx vitest run test/repomap.test.ts`
Expected: FAIL — `Cannot find module '../src/repomap'`.

- [ ] **Step 3: Implementasi** — `src/repomap.ts`:

```ts
import { readdirSync, readFileSync } from 'node:fs'
import { extname, join, relative, sep } from 'node:path'
import { estimateTokens } from './tokenBudget'

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next', 'target', 'vendor', '__pycache__', '.venv', '.cache'])
const CODE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rs', '.java', '.c', '.h', '.cpp', '.hpp', '.cs', '.rb', '.php', '.sh', '.ps1'])
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

export function extractSymbols(text: string, ext: string): string[] {
  const out: string[] = []
  for (const line of text.split('\n')) {
    for (const re of familyFor(ext)) {
      const m = re.exec(line)
      if (m && !out.includes(m[1])) out.push(m[1])
      if (m) break
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

export function buildRepoMapSync(cwd: string, opts: { maxTokens?: number } = {}): string {
  const maxTokens = opts.maxTokens ?? 2048
  const files: string[] = []
  walk(cwd, cwd, files)
  files.sort((a, b) => relative(cwd, a).split(sep).length - relative(cwd, b).split(sep).length || a.localeCompare(b))
  const lines: string[] = []
  let used = 0
  let truncated = false
  for (const file of files) {
    const rel = relative(cwd, file).split(sep).join('/')
    let symbols: string[] = []
    try {
      if (readFileSync(file, { encoding: 'utf8' }).length <= MAX_FILE_BYTES * 4) {
        symbols = extractSymbols(readFileSync(file, 'utf8'), extname(file).toLowerCase())
      }
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
```

`src/tools/repomap.ts`:

```ts
import { z } from 'zod'
import { buildRepoMapSync } from '../repomap'
import { defineTool } from './types'

export function createRepoMapTool() {
  return defineTool({
    name: 'repo_map',
    description:
      'Show a map of this repository: code files (node_modules/.git excluded) with their top-level functions, classes and types. Use it to orient yourself in an unfamiliar repo before searching or reading files.',
    schema: z.object({}),
    run: async (_input, ctx) => ({ output: buildRepoMapSync(ctx.cwd) || '(no code files found)' }),
  })
}
```

`src/context.ts` — tambah field opts + section (setelah `skillText`, sebelum return; sisipkan di template sebelum `${instructions ...}`):

```ts
// opts: tambah repoMap?: string
const mapText = opts.repoMap ? `\n\nRepository map (files and top-level symbols):\n${opts.repoMap}` : ''
// di return: ...${skillText}${mapText}${instructions ? ...
```

`src/config.ts` — tambah di interface Config global: `repoMap?: boolean` (default `false` di DEFAULTS), validasi mengikuti pola `vision`/`updateCheck`:

```ts
function resolveRepoMap(global: GlobalConfig): boolean {
  const value = global.repoMap ?? false
  if (typeof value !== 'boolean') throw new ConfigError(t('repoMap must be true or false.'))
  return value
}
```

(id.ts: `'repoMap must be true or false.': 'repoMap harus true atau false.'`)

`src/setup.ts` — di `createRuntime` setelah `loadConfig`:

```ts
const repoMap = config.repoMap ? buildRepoMapSync(opts.cwd) : undefined
```

lalu teruskan `repoMap` ke SEMUA pemanggilan `buildSystemPrompt` (baris 139, 150, 180, 315) — buat helper lokal `const systemFor = (model: string) => buildSystemPrompt({ cwd: opts.cwd, home, model, skills, repoMap })` dan ganti keempat call site. Daftarkan tool: di `baseTools` tambahkan `createRepoMapTool()`.

- [ ] **Step 4: Jalankan, pastikan GREEN**

Run: `npx vitest run test/repomap.test.ts test/context.test.ts test/setup.test.ts test/i18n.test.ts`
Expected: PASS semua.

- [ ] **Step 5: Commit**

```bash
git add src/repomap.ts src/tools/repomap.ts src/context.ts src/config.ts src/setup.ts src/i18n/id.ts test/repomap.test.ts
git commit -m "feat: repo_map tool + optional repo map in the system prompt"
```

---

### Task 2: Themes (palet warna via config)

**Files:**
- Modify: `src/ui/theme.ts` (rewrite penuh)
- Modify: `src/config.ts` (field `theme?: string` + validasi)
- Modify: `src/cli.ts` (panggil `setTheme` di jalur TUI setelah runtime dibuat)
- Test: `test/theme.test.ts`

**Interfaces:**
- Produces: `setTheme(name: string): void`, `currentTheme(): string`, `THEMES: readonly string[]` = `['default','blue','amber','magenta','mono']`; `color()` lama tetap (signature tidak berubah, semua call site otomatis ikut tema).
- Consumes: tidak ada.

- [ ] **Step 1: Tulis test yang gagal** — `test/theme.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest'
import { color, currentTheme, setTheme, THEMES } from '../src/ui/theme'

describe('themes', () => {
  afterEach(() => {
    setTheme('default')
    delete process.env.NO_COLOR
  })

  it('lists the built-in themes', () => {
    expect(THEMES).toEqual(['default', 'blue', 'amber', 'magenta', 'mono'])
  })

  it('remaps colors per theme without touching call sites', () => {
    expect(setTheme('blue') ?? color('green')).toBe('blue')
    expect(color('gray')).toBe('gray')
    setTheme('amber')
    expect(color('green')).toBe('yellow')
    setTheme('magenta')
    expect(color('green')).toBe('magenta')
  })

  it('mono drops every color', () => {
    setTheme('mono')
    expect(color('green')).toBeUndefined()
    expect(color('red')).toBeUndefined()
  })

  it('NO_COLOR still wins', () => {
    process.env.NO_COLOR = '1'
    setTheme('blue')
    expect(color('green')).toBeUndefined()
  })

  it('unknown themes are rejected by the config loader', () => {
    const { loadConfig, ConfigError } = require('../src/config') as typeof import('../src/config')
    const { mkdtempSync, writeFileSync } = require('node:fs') as typeof import('node:fs')
    const { tmpdir } = require('node:os') as typeof import('node:os')
    const { join } = require('node:path') as typeof import('node:path')
    const home = mkdtempSync(join(tmpdir(), 'bccli-theme-'))
    writeFileSync(join(home, 'config.json'), JSON.stringify({ theme: 'rainbow' }))
    expect(() => loadConfig(home, { BCCLI_HOME: home } as never)).toThrow(ConfigError)
  })
})
```

(Ganti blok `require` dengan import ESM statis di atas file bila biome mengeluh `noRequireImports` — cek `test/config.test.ts` untuk pola membuat home sementara yang sudah dipakai repo ini, dan ikuti pola itu.)

- [ ] **Step 2: Jalankan, pastikan RED**

Run: `npx vitest run test/theme.test.ts`
Expected: FAIL — `setTheme`/`THEMES` tidak diekspor.

- [ ] **Step 3: Implementasi** — `src/ui/theme.ts` (rewrite):

```ts
export const THEMES = ['default', 'blue', 'amber', 'magenta', 'mono'] as const

const REMAP: Record<string, Record<string, string>> = {
  blue: { green: 'blue' },
  amber: { green: 'yellow' },
  magenta: { green: 'magenta' },
}

let theme: string = 'default'

export function setTheme(name: string): void {
  theme = name
}

export function currentTheme(): string {
  return theme
}

export function color(name: string): string | undefined {
  if (process.env.NO_COLOR) return undefined
  if (theme === 'mono') return undefined
  return REMAP[theme]?.[name] ?? name
}

export const ACCENT = 'green'
```

`src/config.ts` — field `theme?: string` di GlobalConfig + Config hasil, default `'default'`, validasi:

```ts
function resolveTheme(global: GlobalConfig): string {
  const value = global.theme ?? 'default'
  if (typeof value !== 'string' || !THEMES.includes(value as (typeof THEMES)[number])) {
    throw new ConfigError(t('theme must be one of: {themes}.', { themes: THEMES.join(', ') }))
  }
  return value
}
```

id.ts: `'theme must be one of: {themes}.': 'theme harus salah satu dari: {themes}.'`

`src/cli.ts` — di jalur TUI (setelah `createRuntime`, sebelum `render`): `setTheme(rt.config.theme)` + import.

- [ ] **Step 4: Jalankan, pastikan GREEN**

Run: `npx vitest run test/theme.test.ts test/config.test.ts test/i18n.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui/theme.ts src/config.ts src/cli.ts src/i18n/id.ts test/theme.test.ts
git commit -m "feat: color themes via global config (default/blue/amber/magenta/mono)"
```

---

### Task 3: Vim mode untuk prompt input

**Files:**
- Create: `src/ui/vim.ts`
- Modify: `src/ui/PromptInput.tsx` (prop `vim`, state mode, indikator)
- Modify: `src/config.ts` (field `editor?: 'emacs' | 'vim'`)
- Modify: `src/ui/App.tsx` (teruskan `vim={...}` dari config)
- Test: `test/vim.test.ts`, `test/ui/vim.test.tsx`

**Interfaces:**
- Produces: `type VimMode = 'normal' | 'insert'`; `applyVim(s: LineState, mode: VimMode, input: string, key: EditKey, pending?: string): { state: LineState; mode: VimMode; pending?: string; handled: boolean }`; config `editor` (default `'emacs'`).
- Consumes: `LineState`/`EditKey`/`wordLeft`/`wordRight`/`lineStart`/`lineEnd`/`moveLine` dari `src/ui/lineEdit.ts`.

- [ ] **Step 1: Tulis test yang gagal** — `test/vim.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { applyVim, type VimMode } from '../src/ui/vim'
import type { EditKey, LineState } from '../src/ui/lineEdit'

const K = (over: Partial<EditKey> = {}): EditKey =>
  ({ upArrow: false, downArrow: false, leftArrow: false, rightArrow: false, ctrl: false, meta: false, shift: false, tab: false, backspace: false, delete: false, escape: false, return: false, pageUp: false, pageDown: false, ...over }) as EditKey

const s = (value: string, cursor = value.length): LineState => ({ value, cursor })
const n = (st: LineState, mode: VimMode, input: string, key = K(), pending?: string) =>
  applyVim(st, mode, input, key, pending)

describe('vim', () => {
  it('esc switches to normal mode and clamps the cursor', () => {
    const r = n(s('hello'), 'insert', '', K({ escape: true }))
    expect(r.mode).toBe('normal')
    expect(r.state.cursor).toBe(4)
  })

  it('i and a enter insert mode (a moves one right)', () => {
    expect(n(s('ab', 0), 'normal', 'i').mode).toBe('insert')
    expect(n(s('ab', 0), 'normal', 'i').state.cursor).toBe(0)
    const a = n(s('ab', 0), 'normal', 'a')
    expect(a.mode).toBe('insert')
    expect(a.state.cursor).toBe(1)
  })

  it('A and o/O enter insert at end / new lines', () => {
    const bigA = n(s('ab', 0), 'normal', 'A')
    expect(bigA.state.cursor).toBe(2)
    const o = n(s('ab', 2), 'normal', 'o')
    expect(o.state.value).toBe('ab\n')
    expect(o.state.cursor).toBe(3)
    const capO = n(s('ab', 2), 'normal', 'O')
    expect(capO.state.value).toBe('\nab')
    expect(capO.state.cursor).toBe(0)
  })

  it('h/l/w/b/0/$ move in normal mode', () => {
    expect(n(s('hello world', 0), 'normal', 'l').state.cursor).toBe(1)
    expect(n(s('hello world', 5), 'normal', 'h').state.cursor).toBe(4)
    expect(n(s('hello world', 0), 'normal', 'w').state.cursor).toBe(6)
    expect(n(s('hello world', 11), 'normal', 'b').state.cursor).toBe(6)
    expect(n(s('hello world', 5), 'normal', '0').state.cursor).toBe(0)
    expect(n(s('hello world', 0), 'normal', '$').state.cursor).toBe(11)
  })

  it('x deletes the character under the cursor', () => {
    const r = n(s('abc', 1), 'normal', 'x')
    expect(r.state.value).toBe('ac')
    expect(r.state.cursor).toBe(1)
  })

  it('dd deletes the current line, dw deletes to the next word', () => {
    const dd = n(s('one\ntwo', 1), 'normal', 'd', K(), undefined)
    expect(dd.pending).toBe('d')
    const dd2 = n(dd.state, 'normal', 'd', K(), 'd')
    expect(dd2.state.value).toBe('two')
    const dw = n(s('one two', 0), 'normal', 'w', K(), 'd')
    expect(dw.state.value).toBe('two')
  })

  it('swallows printable input in normal mode; arrows/ctrl/meta/enter fall through', () => {
    expect(n(s('a', 0), 'normal', 'z').handled).toBe(true)
    expect(n(s('a', 0), 'normal', '', K({ upArrow: true })).handled).toBe(false)
    expect(n(s('a', 0), 'normal', '', K({ ctrl: true })).handled).toBe(false)
    expect(n(s('a', 0), 'normal', '', K({ return: true })).handled).toBe(false)
  })

  it('does not touch insert-mode typing (except esc)', () => {
    expect(n(s('a', 1), 'insert', 'b').handled).toBe(false)
  })
})
```

`test/ui/vim.test.tsx`:

```tsx
import { render } from 'ink-testing-library'
import { describe, expect, it } from 'vitest'
import { PromptInput } from '../../src/ui/PromptInput'

const noop = () => {}

describe('vim prompt input', () => {
  it('starts in insert mode and shows the NORMAL indicator after esc', async () => {
    const { lastFrame, stdin } = render(<PromptInput history={[]} cwd="." onSubmit={noop} vim />)
    stdin.write('hi')
    expect(lastFrame()).toContain('hi')
    stdin.write(String.fromCharCode(27))
    expect(lastFrame()).toContain('NORMAL')
    // in normal mode, typing does not insert
    stdin.write('x')
    expect(lastFrame()).toContain('NORMAL')
    expect(lastFrame()).not.toContain('hix')
  })

  it('x in normal mode deletes a character', async () => {
    const { lastFrame, stdin } = render(<PromptInput history={[]} cwd="." onSubmit={noop} vim />)
    stdin.write('ab')
    stdin.write(String.fromCharCode(27))
    stdin.write('x')
    const frame = lastFrame() ?? ''
    expect(frame).toContain('a')
    expect(frame).not.toContain('ab')
  })

  it('without the vim prop, esc does not show NORMAL', async () => {
    const { lastFrame, stdin } = render(<PromptInput history={[]} cwd="." onSubmit={noop} />)
    stdin.write('hi')
    stdin.write(String.fromCharCode(27))
    expect(lastFrame()).not.toContain('NORMAL')
  })
})
```

- [ ] **Step 2: Jalankan, pastikan RED**

Run: `npx vitest run test/vim.test.ts test/ui/vim.test.tsx`
Expected: FAIL — modul `src/ui/vim` tidak ada; prop `vim` tidak dikenal.

- [ ] **Step 3: Implementasi** — `src/ui/vim.ts`:

```ts
import { lineEnd, lineStart, moveLine, wordLeft, wordRight, type EditKey, type LineState } from './lineEdit'

export type VimMode = 'normal' | 'insert'

export interface VimResult {
  state: LineState
  mode: VimMode
  pending?: string
  handled: boolean
}

const clamp = (s: LineState): LineState => ({ value: s.value, cursor: Math.min(s.cursor, Math.max(0, s.value.length - 1)) })

const deleteLine = (s: LineState): LineState => {
  const from = lineStart(s.value, s.cursor)
  const nl = s.value.indexOf('\n', s.cursor)
  if (nl === -1) {
    // last line: also eat the newline before it, when there is one
    const start = from > 0 ? from - 1 : 0
    return { value: s.value.slice(0, start), cursor: start }
  }
  return { value: s.value.slice(0, from) + s.value.slice(nl + 1), cursor: from }
}

export function applyVim(s: LineState, mode: VimMode, input: string, key: EditKey, pending?: string): VimResult {
  if (key.escape) return { state: clamp(s), mode: 'normal', handled: true }
  if (mode === 'insert') return { state: s, mode, handled: false }
  // fall through keys: navigation arrows, modifiers, enter — handled by the host input loop
  if (key.upArrow || key.downArrow || key.leftArrow || key.rightArrow || key.ctrl || key.meta || key.tab || key.return) {
    return { state: s, mode, pending, handled: false }
  }
  if (pending === 'd') {
    if (input === 'd') return { state: deleteLine(s), mode, handled: true }
    if (input === 'w') {
      const to = wordRight(s.value, s.cursor)
      return { state: { value: s.value.slice(0, s.cursor) + s.value.slice(to), cursor: s.cursor }, mode, handled: true }
    }
    return { state: s, mode, handled: true } // cancel an unknown d-combination
  }
  switch (input) {
    case 'h':
      return { state: { ...s, cursor: Math.max(lineStart(s.value, s.cursor), s.cursor - 1) }, mode, handled: true }
    case 'l':
      return { state: { ...s, cursor: Math.min(lineEnd(s.value, s.cursor), s.cursor + 1) }, mode, handled: true }
    case 'j': {
      const moved = moveLine(s.value, s.cursor, 1)
      return { state: moved === undefined ? s : { ...s, cursor: moved }, mode, handled: true }
    }
    case 'k': {
      const moved = moveLine(s.value, s.cursor, -1)
      return { state: moved === undefined ? s : { ...s, cursor: moved }, mode, handled: true }
    }
    case 'w':
      return { state: { ...s, cursor: wordRight(s.value, s.cursor) }, mode, handled: true }
    case 'b':
      return { state: { ...s, cursor: wordLeft(s.value, s.cursor) }, mode, handled: true }
    case '0':
      return { state: { ...s, cursor: lineStart(s.value, s.cursor) }, mode, handled: true }
    case '$':
      return { state: { ...s, cursor: lineEnd(s.value, s.cursor) }, mode, handled: true }
    case 'x': {
      if (s.cursor >= s.value.length || s.value[s.cursor] === '\n') return { state: s, mode, handled: true }
      return { state: { value: s.value.slice(0, s.cursor) + s.value.slice(s.cursor + 1), cursor: s.cursor }, mode, handled: true }
    }
    case 'i':
      return { state: s, mode: 'insert', handled: true }
    case 'a':
      return { state: { ...s, cursor: Math.min(s.cursor + 1, s.value.length) }, mode: 'insert', handled: true }
    case 'A':
      return { state: { ...s, cursor: lineEnd(s.value, s.cursor) }, mode: 'insert', handled: true }
    case 'o': {
      const end = lineEnd(s.value, s.cursor)
      return { state: { value: s.value.slice(0, end) + '\n' + s.value.slice(end), cursor: end + 1 }, mode: 'insert', handled: true }
    }
    case 'O': {
      const start = lineStart(s.value, s.cursor)
      return { state: { value: s.value.slice(0, start) + '\n' + s.value.slice(start), cursor: start }, mode: 'insert', handled: true }
    }
    case 'd':
      return { state: s, mode, pending: 'd', handled: true }
    default:
      return { state: s, mode, handled: true } // swallow everything else in normal mode
  }
}
```

`src/ui/PromptInput.tsx`:
- Props: tambah `vim?: boolean`.
- State: `const [vimMode, setVimMode] = useState<VimMode>('insert')` dan `const [vimPending, setVimPending] = useState<string | undefined>()`.
- Di `useInput`, tepat setelah blok suggestions dan SEBELUM `if (key.return)`: tidak — urutan benar: blok suggestions tetap pertama; lalu `if (key.return)` submit tetap jalan di kedua mode; lalu sebelum `applyEditKey`:

```ts
if (vim) {
  const r = applyVim(line, vimMode, input, key, vimPending)
  if (r.handled) {
    setLine(r.state)
    setVimMode(r.mode)
    setVimPending(r.pending)
    setSelected(0)
    return
  }
}
```

- Setelah submit成功 (`edit(typed(''))`), reset `setVimMode('insert')` + `setVimPending(undefined)`.
- Render: di dalam `<Box borderStyle="round" ...>`, setelah `<EditableText .../>`, tambah indikator:

```tsx
{vim && vimMode === 'normal' && <Text color={color('green')}> {t('NORMAL')}</Text>}
```

id.ts: `'NORMAL': '-- NORMAL --'`.
- Import: `applyVim, type VimMode` dari `'./vim'`.

`src/config.ts`: field `editor?: 'emacs' | 'vim'` (global-only), default `'emacs'`, validasi:

```ts
function resolveEditor(global: GlobalConfig): 'emacs' | 'vim' {
  const value = global.editor ?? 'emacs'
  if (value !== 'emacs' && value !== 'vim') throw new ConfigError(t('editor must be "emacs" or "vim".'))
  return value
}
```

id.ts: `'editor must be "emacs" or "vim".': 'editor harus "emacs" atau "vim".'`

`src/ui/App.tsx`: cari render `<PromptInput` — tambah prop `vim={config.editor === 'vim'}` (ikuti cara App mengakses config/runtime yang sudah ada, mis. `rt.config` atau prop `config`; samakan dengan pola prop `injected` yang ditambahkan di Fase 1).

- [ ] **Step 4: Jalankan, pastikan GREEN**

Run: `npx vitest run test/vim.test.ts test/ui/vim.test.tsx test/config.test.ts test/i18n.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui/vim.ts src/ui/PromptInput.tsx src/ui/App.tsx src/config.ts src/i18n/id.ts test/vim.test.ts test/ui/vim.test.tsx
git commit -m "feat: vim editing mode for the prompt (config editor: vim)"
```

---

### Task 4: Sandbox bash (sandbox-exec / bwrap)

**Files:**
- Create: `src/tools/sandbox.ts`
- Modify: `src/tools/bash.ts` (`runCommand`/`startBackground` terima argv; `BashToolOptions.sandbox`; option `platform` utk test)
- Modify: `src/config.ts` (field `sandbox?: 'off' | 'on'`)
- Modify: `src/setup.ts:154` (teruskan `sandbox: config.sandbox === 'on'`)
- Test: `test/sandbox.test.ts`

**Interfaces:**
- Produces: `sandboxSupported(platform: NodeJS.Platform): boolean`, `darwinProfile(cwd: string, network: boolean): string`, `sandboxArgv(command: string, opts: { platform: NodeJS.Platform; cwd: string; network: boolean }): string[] | undefined`; `runCommand(command: string | string[], ...)`; `createBashTool({ sandbox?, platform? })`.
- Consumes: tidak ada modul baru.

- [ ] **Step 1: Tulis test yang gagal** — `test/sandbox.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { darwinProfile, sandboxArgv, sandboxSupported } from '../src/tools/sandbox'
import { createBashTool, runCommand } from '../src/tools/bash'

describe('sandbox', () => {
  it('supports darwin and linux only', () => {
    expect(sandboxSupported('darwin')).toBe(true)
    expect(sandboxSupported('linux')).toBe(true)
    expect(sandboxSupported('win32')).toBe(false)
  })

  it('darwin profile allows writes under cwd/tmp and gates the network', () => {
    const p = darwinProfile('/proj', false)
    expect(p).toContain('(version 1)')
    expect(p).toContain('(subpath "/proj")')
    expect(p).not.toContain('(allow network')
    expect(darwinProfile('/proj', true)).toContain('(allow network')
  })

  it('darwin argv uses sandbox-exec with the profile', () => {
    const argv = sandboxArgv('ls', { platform: 'darwin', cwd: '/proj', network: true })
    expect(argv?.[0]).toBe('sandbox-exec')
    expect(argv).toContain('-p')
    expect(argv?.slice(-2)).toEqual(['/bin/bash', '-c'])
    expect(argv?.at(-1)).toBe('ls')
  })

  it('linux argv uses bwrap and unshares the network only when offline', () => {
    const off = sandboxArgv('ls', { platform: 'linux', cwd: '/proj', network: false })
    expect(off?.[0]).toBe('bwrap')
    expect(off).toContain('--unshare-net')
    expect(off).toContain('--ro-bind')
    const on = sandboxArgv('ls', { platform: 'linux', cwd: '/proj', network: true })
    expect(on).not.toContain('--unshare-net')
  })

  it('win32 has no argv', () => {
    expect(sandboxArgv('ls', { platform: 'win32', cwd: 'C:/x', network: true })).toBeUndefined()
  })

  it('runCommand accepts an argv array (no shell)', async () => {
    const r = await runCommand([process.execPath, '-e', 'console.log("SBX_ARGV_OK")'], {
      cwd: process.cwd(),
      timeoutMs: 15_000,
      signal: new AbortController().signal,
    })
    expect(r.output).toContain('SBX_ARGV_OK')
    expect(r.exitCode).toBe(0)
  })

  it('the bash tool refuses sandboxed runs on unsupported platforms', async () => {
    const tool = createBashTool({ sandbox: true, platform: 'win32' })
    const r = await tool.run({ command: 'echo hi' }, { cwd: process.cwd(), signal: new AbortController().signal } as never)
    expect(r.isError).toBe(true)
    expect(r.output.toLowerCase()).toContain('sandbox')
  })
})
```

- [ ] **Step 2: Jalankan, pastikan RED**

Run: `npx vitest run test/sandbox.test.ts`
Expected: FAIL — `../src/tools/sandbox` tidak ada; `runCommand` belum terima array.

- [ ] **Step 3: Implementasi** — `src/tools/sandbox.ts`:

```ts
export function sandboxSupported(platform: NodeJS.Platform): boolean {
  return platform === 'darwin' || platform === 'linux'
}

/** Seatbelt profile: read everything, write only under cwd + temp areas, network only when allowed. */
export function darwinProfile(cwd: string, network: boolean): string {
  const writable = [cwd, '/tmp', '/private/tmp', '/dev', '/var/folders']
    .map((p) => `(subpath "${p}")`)
    .join(' ')
  return [
    '(version 1)',
    '(deny default)',
    '(allow process*)',
    '(allow signal (target self))',
    '(allow sysctl-read)',
    '(allow file-read*)',
    `(allow file-write* ${writable})`,
    '(allow mach-lookup)',
    '(allow ipc-posix*)',
    network ? '(allow network*)' : '(deny network*)',
  ].join('\n')
}

export function sandboxArgv(
  command: string,
  opts: { platform: NodeJS.Platform; cwd: string; network: boolean },
): string[] | undefined {
  if (opts.platform === 'darwin') {
    return ['sandbox-exec', '-p', darwinProfile(opts.cwd, opts.network), '/bin/bash', '-c', command]
  }
  if (opts.platform === 'linux') {
    return [
      'bwrap',
      '--ro-bind', '/', '/',
      '--dev-bind', '/dev', '/dev',
      '--proc', '/proc',
      '--bind', opts.cwd, opts.cwd,
      '--tmpfs', '/tmp',
      '--die-with-parent',
      ...(opts.network ? [] : ['--unshare-net']),
      '--', '/bin/bash', '-c', command,
    ]
  }
  return undefined
}
```

`src/tools/bash.ts`:
- `runCommand(command: string | string[], opts)` — di dalam:

```ts
const child = Array.isArray(command)
  ? spawn(command[0], command.slice(1), { cwd: opts.cwd, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'], env: opts.env })
  : spawn(command, { cwd: opts.cwd, shell: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'], env: opts.env })
```

- `startBackground(command: string | string[], cwd, env)` — pola spawn sama; field `task.command` jadi `Array.isArray(command) ? command.join(' ') : command` (untuk display /tasks).
- `BashToolOptions`: tambah `sandbox?: boolean` dan `platform?: NodeJS.Platform` (default `process.platform`).
- Di `run()`, setelah cek networkPolicy dan setelah `input.command` dipastikan ada, sebelum branch background:

```ts
let exec: string | string[] = input.command
if (options.sandbox) {
  const argv = sandboxArgv(input.command, { platform, cwd: ctx.cwd, network: !offline })
  if (!argv) {
    return { output: t('sandbox is not supported on {platform}; disable "sandbox" in ~/.bccli/config.json or run on macOS/Linux.', { platform }), isError: true }
  }
  exec = argv
}
```

lalu `startBackground(exec, ...)` / `runCommand(exec, ...)`.
- id.ts: `'sandbox is not supported on {platform}; disable "sandbox" in ~/.bccli/config.json or run on macOS/Linux.': 'sandbox tidak didukung di {platform}; matikan "sandbox" di ~/.bccli/config.json atau jalankan di macOS/Linux.'`

`src/config.ts`: field `sandbox?: 'off' | 'on'` (global-only), default `'off'`:

```ts
function resolveSandbox(global: GlobalConfig): 'off' | 'on' {
  const value = global.sandbox ?? 'off'
  if (value !== 'off' && value !== 'on') throw new ConfigError(t('sandbox must be "off" or "on".'))
  return value
}
```

id.ts: `'sandbox must be "off" or "on".': 'sandbox harus "off" atau "on".'`

`src/setup.ts:154`: `createBashTool({ networkPolicy: config.networkPolicy, sandbox: config.sandbox === 'on' })`.

- [ ] **Step 4: Jalankan, pastikan GREEN + regresi bash**

Run: `npx vitest run test/sandbox.test.ts test/tools/bash.test.ts test/networkPolicy.test.ts`
(cocokkan nama file test bash yang ada via `rg -l "createBashTool" test` — jalankan semuanya.)
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tools/sandbox.ts src/tools/bash.ts src/config.ts src/setup.ts src/i18n/id.ts test/sandbox.test.ts
git commit -m "feat: opt-in OS sandbox for bash (sandbox-exec on macOS, bwrap on Linux)"
```

---

### Task 5: LSP diagnostics dasar (tool `diagnostics`)

**Files:**
- Create: `src/lsp.ts`
- Create: `src/tools/diagnostics.ts`
- Create: `test/fixtures/fake-lsp.mjs`
- Modify: `src/config.ts` (field `lsp?: { servers?: LspServer[] }`)
- Modify: `src/setup.ts` (daftarkan tool bila ada server)
- Test: `test/lsp.test.ts`

**Interfaces:**
- Produces: `interface LspServer { extensions: string[]; command: string; args?: string[] }`; `interface LspDiagnostic { line: number; character: number; severity: number; message: string }`; `encodeLsp(msg: unknown): Buffer`; `createLspParser(onMessage: (msg: any) => void): { push(chunk: Buffer): void }`; `getDiagnostics(opts: { server: LspServer; cwd: string; file: string; timeoutMs?: number }): Promise<LspDiagnostic[]>`; `createDiagnosticsTool(servers: LspServer[]): Tool`.
- Consumes: `resolvePath` dari `src/tools/paths.ts`, `defineTool` dari `src/tools/types.ts`.

- [ ] **Step 1: Tulis fixture** — `test/fixtures/fake-lsp.mjs` (server LSP minimal untuk test; biome sudah exclude `test/fixtures/**`):

```js
// Minimal fake LSP server for tests: answers initialize/shutdown and publishes
// one canned error diagnostic for every didOpen.
let buf = Buffer.alloc(0)
const send = (msg) => {
  const body = Buffer.from(JSON.stringify(msg), 'utf8')
  process.stdout.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]))
}
const handle = (msg) => {
  if (msg.method === 'initialize') send({ jsonrpc: '2.0', id: msg.id, result: { capabilities: {} } })
  if (msg.method === 'textDocument/didOpen') {
    send({
      jsonrpc: '2.0',
      method: 'textDocument/publishDiagnostics',
      params: {
        uri: msg.params.textDocument.uri,
        diagnostics: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, severity: 1, message: 'fake problem' }],
      },
    })
  }
  if (msg.method === 'shutdown') send({ jsonrpc: '2.0', id: msg.id, result: null })
  if (msg.method === 'exit') process.exit(0)
}
process.stdin.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk])
  for (;;) {
    const idx = buf.indexOf('\r\n\r\n')
    if (idx < 0) return
    const m = /Content-Length:\s*(\d+)/i.exec(buf.subarray(0, idx).toString('ascii'))
    if (!m) { buf = buf.subarray(idx + 4); continue }
    const len = Number(m[1])
    if (buf.length < idx + 4 + len) return
    const body = buf.subarray(idx + 4, idx + 4 + len)
    buf = buf.subarray(idx + 4 + len)
    try { handle(JSON.parse(body.toString('utf8'))) } catch {}
  }
})
```

- [ ] **Step 2: Tulis test yang gagal** — `test/lsp.test.ts`:

```ts
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createLspParser, encodeLsp, getDiagnostics } from '../src/lsp'
import { createDiagnosticsTool } from '../src/tools/diagnostics'

const FIXTURE = fileURLToPath(new URL('./fixtures/fake-lsp.mjs', import.meta.url))
const SERVER = { extensions: ['.ts'], command: process.execPath, args: [FIXTURE] }

describe('lsp framing', () => {
  it('round-trips a message through encode + parser', () => {
    const seen: unknown[] = []
    const parser = createLspParser((m) => seen.push(m))
    parser.push(encodeLsp({ jsonrpc: '2.0', id: 1, method: 'x', params: { a: 1 } }))
    expect(seen).toEqual([{ jsonrpc: '2.0', id: 1, method: 'x', params: { a: 1 } }])
  })

  it('handles a message split across chunks', () => {
    const seen: unknown[] = []
    const parser = createLspParser((m) => seen.push(m))
    const full = encodeLsp({ jsonrpc: '2.0', id: 2 })
    parser.push(full.subarray(0, 10))
    expect(seen).toEqual([])
    parser.push(full.subarray(10))
    expect(seen).toHaveLength(1)
  })
})

describe('lsp diagnostics', () => {
  it('collects publishDiagnostics from a real (fake) server', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bccli-lsp-'))
    const file = join(root, 'a.ts')
    writeFileSync(file, 'const x: number = "nope"\n')
    const diags = await getDiagnostics({ server: SERVER, cwd: root, file, timeoutMs: 10_000 })
    expect(diags).toEqual([{ line: 0, character: 0, severity: 1, message: 'fake problem' }])
  })

  it('resolves empty when the server times out', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bccli-lsp2-'))
    const file = join(root, 'a.ts')
    writeFileSync(file, 'x')
    // a server that never answers: node reading stdin forever
    const diags = await getDiagnostics({
      server: { extensions: ['.ts'], command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'] },
      cwd: root,
      file,
      timeoutMs: 300,
    })
    expect(diags).toEqual([])
  })

  it('the diagnostics tool formats results and rejects unknown extensions', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bccli-lsp3-'))
    const file = join(root, 'a.ts')
    writeFileSync(file, 'const x = 1\n')
    const tool = createDiagnosticsTool([SERVER])
    expect(tool.name).toBe('diagnostics')
    const ctx = { cwd: root, signal: new AbortController().signal } as never
    const ok = await tool.run({ path: 'a.ts' }, ctx)
    expect(ok.output).toContain('1:1')
    expect(ok.output).toContain('fake problem')
    const other = join(root, 'b.txt')
    writeFileSync(other, 'hi')
    const bad = await tool.run({ path: 'b.txt' }, ctx)
    expect(bad.isError).toBe(true)
    expect(bad.output).toContain('.txt')
  })
})
```

- [ ] **Step 3: Jalankan, pastikan RED**

Run: `npx vitest run test/lsp.test.ts`
Expected: FAIL — `../src/lsp` tidak ada.

- [ ] **Step 4: Implementasi** — `src/lsp.ts`:

```ts
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export interface LspServer {
  extensions: string[]
  command: string
  args?: string[]
}

export interface LspDiagnostic {
  line: number
  character: number
  severity: number
  message: string
}

export function encodeLsp(msg: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(msg), 'utf8')
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body])
}

export function createLspParser(onMessage: (msg: any) => void): { push(chunk: Buffer): void } {
  let buf = Buffer.alloc(0)
  return {
    push(chunk: Buffer) {
      buf = Buffer.concat([buf, chunk])
      for (;;) {
        const idx = buf.indexOf('\r\n\r\n')
        if (idx < 0) return
        const m = /Content-Length:\s*(\d+)/i.exec(buf.subarray(0, idx).toString('ascii'))
        if (!m) {
          buf = buf.subarray(idx + 4)
          continue
        }
        const len = Number(m[1])
        if (buf.length < idx + 4 + len) return
        const body = buf.subarray(idx + 4, idx + 4 + len)
        buf = buf.subarray(idx + 4 + len)
        try {
          onMessage(JSON.parse(body.toString('utf8')))
        } catch {
          // a corrupt frame must not kill the stream
        }
      }
    },
  }
}

/** Open one file with one LSP server, wait for its first publishDiagnostics (or the timeout), then shut it down. */
export function getDiagnostics(opts: {
  server: LspServer
  cwd: string
  file: string
  timeoutMs?: number
}): Promise<LspDiagnostic[]> {
  return new Promise((resolve) => {
    const child = spawn(opts.server.command, opts.server.args ?? [], { cwd: opts.cwd, stdio: ['pipe', 'pipe', 'ignore'] })
    const uri = pathToFileURL(opts.file).href
    let settled = false
    let nextId = 1
    const send = (msg: unknown) => {
      try {
        child.stdin.write(encodeLsp(msg))
      } catch {
        // the server may already be gone
      }
    }
    const finish = (diags: LspDiagnostic[]) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      send({ jsonrpc: '2.0', id: nextId++, method: 'shutdown' })
      send({ jsonrpc: '2.0', method: 'exit' })
      setTimeout(() => {
        try {
          child.kill()
        } catch {}
      }, 500).unref?.()
      resolve(diags)
    }
    const timer = setTimeout(() => finish([]), opts.timeoutMs ?? 8_000)
    const parser = createLspParser((msg) => {
      if (msg.id === 1 && msg.result) {
        send({ jsonrpc: '2.0', method: 'initialized', params: {} })
        let text = ''
        try {
          text = readFileSync(opts.file, 'utf8')
        } catch {}
        send({
          jsonrpc: '2.0',
          method: 'textDocument/didOpen',
          params: { textDocument: { uri, languageId: 'plaintext', version: 1, text } },
        })
      }
      if (msg.method === 'textDocument/publishDiagnostics' && msg.params?.uri === uri) {
        finish(
          (msg.params.diagnostics ?? []).map((d: any) => ({
            line: d.range?.start?.line ?? 0,
            character: d.range?.start?.character ?? 0,
            severity: d.severity ?? 1,
            message: String(d.message ?? ''),
          })),
        )
      }
    })
    child.stdout?.on('data', (c: Buffer) => parser.push(c))
    child.on('error', () => finish([]))
    child.on('close', () => finish([]))
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { processId: process.pid, capabilities: {}, rootUri: pathToFileURL(opts.cwd).href },
    })
  })
}
```

`src/tools/diagnostics.ts`:

```ts
import { readFileSync } from 'node:fs'
import { extname } from 'node:path'
import { z } from 'zod'
import { getDiagnostics, type LspServer } from '../lsp'
import { t } from '../i18n'
import { resolvePath } from './paths'
import { defineTool } from './types'

const SEVERITY: Record<number, string> = { 1: 'error', 2: 'warning', 3: 'info', 4: 'hint' }

export function createDiagnosticsTool(servers: LspServer[]) {
  return defineTool({
    name: 'diagnostics',
    description:
      'Run the configured LSP server(s) on one file and return its diagnostics (errors/warnings). Configure servers under "lsp.servers" in ~/.bccli/config.json, e.g. { "extensions": [".ts"], "command": "typescript-language-server", "args": ["--stdio"] }.',
    schema: z.object({ path: z.string().describe('File to check (absolute or relative to the working directory)') }),
    async run(input: z.infer<typeof z.object({ path: z.string() })>, ctx) {
      const file = resolvePath(input.path, ctx.cwd)
      const ext = extname(file).toLowerCase()
      const server = servers.find((s) => s.extensions.includes(ext))
      if (!server) {
        return { output: t('No LSP server is configured for {ext} files.', { ext: ext || '(none)' }), isError: true }
      }
      let text = ''
      try {
        text = readFileSync(file, 'utf8')
      } catch (e) {
        return { output: `Cannot read ${input.path}: ${(e as Error).message}`, isError: true }
      }
      const diags = await getDiagnostics({ server, cwd: ctx.cwd, file, timeoutMs: 15_000 })
      if (!diags.length) return { output: 'No diagnostics.' }
      const lines = diags.map((d) => `${input.path}:${d.line + 1}:${d.character + 1} ${SEVERITY[d.severity] ?? 'error'} ${d.message}`)
      return { output: lines.join('\n'), isError: diags.some((d) => d.severity === 1) }
    },
  })
}
```

(Cek signature pasti `resolvePath` di `src/tools/paths.ts` dan samakan argumennya; cek juga bentuk `ctx` tool dari `defineTool` di `src/tools/types.ts` — test memakai `{ cwd, signal }`.)

id.ts: `'No LSP server is configured for {ext} files.': 'Tidak ada server LSP yang dikonfigurasi untuk file {ext}.'`

`src/config.ts` — field global `lsp?: { servers?: LspServer[] }`, validasi:

```ts
function resolveLsp(global: GlobalConfig): { servers: LspServer[] } | undefined {
  if (global.lsp === undefined) return undefined
  if (typeof global.lsp !== 'object' || global.lsp === null || !Array.isArray((global.lsp as any).servers)) {
    throw new ConfigError(t('lsp must be an object with a "servers" array.'))
  }
  for (const s of (global.lsp as any).servers) {
    if (
      typeof s?.command !== 'string' || !s.command ||
      !Array.isArray(s?.extensions) || s.extensions.length === 0 ||
      s.extensions.some((e: unknown) => typeof e !== 'string' || !e.startsWith('.')) ||
      (s.args !== undefined && (!Array.isArray(s.args) || s.args.some((a: unknown) => typeof a !== 'string')))
    ) {
      throw new ConfigError(t('Each lsp server needs { "extensions": [".ts"], "command": "...", "args": ["..."] }.'))
    }
  }
  return { servers: (global.lsp as any).servers }
}
```

id.ts untuk kedua pesan di atas.

`src/setup.ts` — setelah `baseTools` dibentuk: `if (config.lsp?.servers.length) baseTools.push(createDiagnosticsTool(config.lsp.servers))` (SEBELUM `loadPlugins` agar `builtinNames` ikut mencakupnya).

- [ ] **Step 5: Jalankan, pastikan GREEN**

Run: `npx vitest run test/lsp.test.ts test/config.test.ts test/i18n.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lsp.ts src/tools/diagnostics.ts src/config.ts src/setup.ts src/i18n/id.ts test/lsp.test.ts test/fixtures/fake-lsp.mjs
git commit -m "feat: diagnostics tool backed by user-configured LSP servers"
```

---

### Task 6: SDK programatik (`@botconnector/bccli` sebagai library)

**Files:**
- Create: `src/sdk.ts`
- Modify: `tsup.config.ts` (entry kedua, banner hanya untuk cli)
- Modify: `package.json` (field `exports`)
- Test: `test/sdk.test.ts`

**Interfaces:**
- Produces: `runTask(opts: SdkOptions): Promise<SdkResult>`, `streamTask(opts: SdkOptions): AsyncGenerator<SdkEvent>`, tipe `SdkOptions/SdkResult/SdkEvent/SdkToolCall`.
- Consumes: `createRuntime` dari `src/setup.ts`, `parseCliArgs` dari `src/args.ts`, tipe `Provider` dari `src/provider.ts`.

- [ ] **Step 1: Tulis test yang gagal** — `test/sdk.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { runTask, streamTask } from '../src/sdk'
import type { ChatRequest, Completion, Provider } from '../src/provider'

function scripted(steps: Completion[]): Provider {
  const requests: ChatRequest[] = []
  return {
    requests,
    async chat(req: ChatRequest): Promise<Completion> {
      requests.push(req)
      return steps[Math.min(requests.length - 1, steps.length - 1)]
    },
    async listModels() {
      return ['sdk-model']
    },
  } as Provider & { requests: ChatRequest[] }
}

const reply = (text: string, usage?: { inputTokens: number; outputTokens: number }): Completion => ({
  text,
  toolCalls: [],
  usage,
})

describe('sdk', () => {
  it('runTask returns the final text and usage', async () => {
    const result = await runTask({
      prompt: 'say hi',
      provider: scripted([reply('HALO_SDK', { inputTokens: 10, outputTokens: 5 })]),
      cwd: process.cwd(),
      model: 'sdk/sdk-model',
    })
    expect(result.text).toContain('HALO_SDK')
    expect(result.stopReason).toBe('done')
    expect(result.usage.inputTokens).toBe(10)
  })

  it('streamTask yields text deltas and a final result event', async () => {
    const events: { type: string }[] = []
    for await (const e of streamTask({
      prompt: 'say hi',
      provider: scripted([reply('STREAM_OK')]),
      cwd: process.cwd(),
      model: 'sdk/sdk-model',
    })) {
      events.push(e)
    }
    expect(events.some((e) => e.type === 'text')).toBe(true)
    expect(events.at(-1)?.type).toBe('result')
  })
})
```

Catatan integrasi: `createRuntime` memakai `resolveModel(config, ref, env)` — model `sdk/sdk-model` butuh provider `sdk` terdaftar. Cara paling gampang: test membuat `BCCLI_HOME` sementara dengan `config.json` `{ "model": "sdk/sdk-model", "providers": { "sdk": { "baseURL": "http://127.0.0.1:9/v1" } } }` dan mengoper `env: { ...process.env, BCCLI_HOME: home }` ke `runTask` (SdkOptions punya `env`). Karena `provider` di-stub, baseURL tidak pernah dihubungi. Tambahkan setup itu di kedua test bila `resolveModel` melempar tanpa config.

- [ ] **Step 2: Jalankan, pastikan RED**

Run: `npx vitest run test/sdk.test.ts`
Expected: FAIL — `../src/sdk` tidak ada.

- [ ] **Step 3: Implementasi** — `src/sdk.ts`:

```ts
import { parseCliArgs } from './args'
import type { Provider } from './provider'
import { createRuntime } from './setup'

export interface SdkOptions {
  prompt: string
  cwd?: string
  model?: string
  maxSteps?: number
  provider?: Provider
  env?: NodeJS.ProcessEnv
  fetch?: typeof fetch
  signal?: AbortSignal
}

export interface SdkToolCall {
  name: string
  input: unknown
  output?: string
  isError?: boolean
}

export interface SdkResult {
  text: string
  toolCalls: SdkToolCall[]
  usage: { inputTokens: number; outputTokens: number }
  stopReason: 'done' | 'stepLimit' | 'aborted' | 'budgetExceeded'
}

export type SdkEvent =
  | { type: 'text'; delta: string }
  | { type: 'thinking'; delta: string }
  | { type: 'toolStart'; name: string; input: unknown }
  | { type: 'toolEnd'; name: string; input: unknown; output: string; isError?: boolean }
  | { type: 'usage'; inputTokens: number; outputTokens: number }
  | { type: 'result'; result: SdkResult }

export async function* streamTask(opts: SdkOptions): AsyncGenerator<SdkEvent> {
  const args = parseCliArgs([])
  const rt = createRuntime({
    cwd: opts.cwd ?? process.cwd(),
    args: { ...args, allowAll: true, model: opts.model ?? args.model },
    env: opts.env,
    provider: opts.provider,
    fetch: opts.fetch,
  })
  if (opts.maxSteps !== undefined) rt.agent.maxSteps = opts.maxSteps
  const queue: SdkEvent[] = []
  let wake: (() => void) | null = null
  let finished = false
  let text = ''
  let stopReason: SdkResult['stopReason'] = 'done'
  const usage = { inputTokens: 0, outputTokens: 0 }
  const toolCalls: SdkToolCall[] = []
  const byId = new Map<string, SdkToolCall>()
  const push = (e: SdkEvent) => {
    queue.push(e)
    wake?.()
  }
  rt.agent.onEvent = (event) => {
    switch (event.type) {
      case 'text':
        text += event.delta
        push({ type: 'text', delta: event.delta })
        break
      case 'thinking':
        push({ type: 'thinking', delta: event.delta })
        break
      case 'toolStart': {
        const call: SdkToolCall = { name: event.name, input: event.input }
        byId.set(event.id, call)
        toolCalls.push(call)
        push({ type: 'toolStart', name: event.name, input: event.input })
        break
      }
      case 'toolEnd': {
        const call = byId.get(event.id)
        if (call) {
          call.output = event.output
          call.isError = event.isError
        }
        push({ type: 'toolEnd', name: call?.name ?? '', input: call?.input, output: event.output, isError: event.isError })
        break
      }
      case 'usage':
        usage.inputTokens = event.inputTokens
        usage.outputTokens = event.outputTokens
        push({ type: 'usage', ...usage })
        break
      case 'stepLimit':
        stopReason = 'stepLimit'
        break
      case 'aborted':
        stopReason = 'aborted'
        break
      case 'budgetExceeded':
        stopReason = 'budgetExceeded'
        break
      case 'done':
        finished = true
        wake?.()
        break
      default:
        break
    }
  }
  const running = rt.agent.run(opts.prompt, opts.signal ?? new AbortController().signal).catch(() => {
    stopReason = 'aborted'
  })
  await running
  finished = true
  while (queue.length || !finished) {
    if (queue.length) {
      yield queue.shift() as SdkEvent
      continue
    }
    await new Promise<void>((resolve) => {
      wake = resolve
    })
    wake = null
  }
  const result: SdkResult = { text, toolCalls, usage, stopReason }
  yield { type: 'result', result }
}

export async function runTask(opts: SdkOptions): Promise<SdkResult> {
  let out: SdkResult = { text: '', toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 }, stopReason: 'done' }
  for await (const e of streamTask(opts)) if (e.type === 'result') out = e.result
  return out
}
```

PENTING saat implementasi: cek nama field event agent yang sebenarnya di `src/agent.ts` (`toolStart` punya `id/name/input`? `toolEnd` punya `id/output/isError`? `usage` punya `inputTokens/outputTokens`?) dan sesuaikan switch di atas — jangan menambah field baru ke AgentEvent. `textReplace` (recovery) boleh diabaikan di SDK v1. Karena `agent.run` di-await sampai selesai sebelum draining, sederhanakan: await run, lalu drain queue (loop `while (queue.length) yield ...`) — streaming tetap berfungsi untuk pemanggil yang mengiterasi sementara run berjalan HANYA bila drain diinterleave; untuk v1 cukup: jalankan `running` TANPA await dulu, drain dengan loop wake sampai `finished && queue kosong`, terakhir `await running`. (Pilih interleaved: mulai `running`, drain loop, akhiri `await running`.)

`tsup.config.ts`:

```ts
export default defineConfig({
  entry: ['src/cli.ts', 'src/sdk.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  clean: true,
  banner: { js: (ctx) => (ctx.entryPoint === 'cli' ? '#!/usr/bin/env node' : '') },
  define: { __VERSION__: JSON.stringify(pkg.version) },
})
```

(bila tsup 8 menolak banner fungsi, fallback: hapus banner dari config dan tambahkan shebang lewat `esbuildOptions`/plugin — verifikasi hasil `dist/cli.js` tetap punya shebang dan `dist/sdk.js` tidak.)

`package.json` — tambah:

```json
"exports": { ".": "./dist/sdk.js" }
```

- [ ] **Step 4: Jalankan, pastikan GREEN + build**

Run: `npx vitest run test/sdk.test.ts; npm run build`
Expected: PASS; `dist/sdk.js` ada tanpa shebang, `dist/cli.js` dengan shebang.

- [ ] **Step 5: Commit**

```bash
git add src/sdk.ts tsup.config.ts package.json test/sdk.test.ts
git commit -m "feat: programmatic SDK entry point (runTask/streamTask) exported from the package"
```

---

### Task 7: ACP — agent server minimal (newline-delimited JSON-RPC)

**Files:**
- Create: `src/acp.ts`
- Modify: `src/args.ts` (command `'acp'` di union + parse + HELP EN)
- Modify: `src/cli.ts` (dispatch `acp`)
- Modify: `src/i18n/id.ts` (nilai ID baris HELP)
- Test: `test/acp.test.ts`

**Interfaces:**
- Produces: `interface AcpAgent { run(text: string, onChunk: (t: string) => void, signal: AbortSignal): Promise<void>; abort?(): void }`; `runAcp(input: NodeJS.ReadableStream, output: NodeJS.WritableStream, opts: { cwd: string; newAgent: (cwd: string) => AcpAgent; env?: NodeJS.ProcessEnv }): Promise<void>`; `ACP_PROTOCOL_VERSION = 1`.
- Consumes: `createRuntime` (dipakai factory produksi di cli.ts, tidak di test).

Subset protokol (cukup untuk editor yang berbicara ACP dasar):
- request `initialize` → `{ protocolVersion: 1, agentCapabilities: { loadSession: false, promptCapabilities: { image: false, audio: false, embeddedContext: false } } }`
- request `session/new` (params `{ cwd }`) → `{ sessionId }`
- request `session/prompt` (params `{ sessionId, prompt: [{ type: 'text', text }] }`) → notifikasi `session/update` `{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } }` per chunk, lalu result `{ stopReason: 'end_turn' | 'cancelled' }`
- notification `session/cancel` (params `{ sessionId }`) → abort run berjalan
- method tak dikenal dengan id → error `{ code: -32601, message: 'Method not found' }`

- [ ] **Step 1: Tulis test yang gagal** — `test/acp.test.ts`:

```ts
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { ACP_PROTOCOL_VERSION, runAcp, type AcpAgent } from '../src/acp'

function harness(agent: AcpAgent) {
  const input = new PassThrough()
  const output = new PassThrough()
  let raw = ''
  const messages: any[] = []
  output.on('data', (c: Buffer) => {
    raw += c.toString('utf8')
    let idx: number
    while ((idx = raw.indexOf('\n')) >= 0) {
      const line = raw.slice(0, idx)
      raw = raw.slice(idx + 1)
      if (line.trim()) messages.push(JSON.parse(line))
    }
  })
  const done = runAcp(input, output, { cwd: '.', newAgent: () => agent })
  const send = (msg: unknown) => input.write(`${JSON.stringify(msg)}\n`)
  const waitFor = async (pred: (m: any) => boolean, ms = 2000): Promise<any> => {
    const start = Date.now()
    for (;;) {
      const hit = messages.find(pred)
      if (hit) return hit
      if (Date.now() - start > ms) throw new Error(`timeout waiting; got ${JSON.stringify(messages)}`)
      await new Promise((r) => setTimeout(r, 10))
    }
  }
  return { send, waitFor, messages, finish: () => input.end(), done }
}

const echoAgent: AcpAgent = {
  async run(text, onChunk) {
    onChunk(`echo:${text}`)
  },
}

describe('acp', () => {
  it('answers initialize, session/new and session/prompt with chunks', async () => {
    const h = harness(echoAgent)
    h.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    const init = await h.waitFor((m) => m.id === 1)
    expect(init.result.protocolVersion).toBe(ACP_PROTOCOL_VERSION)
    h.send({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: '.', mcpServers: [] } })
    const sess = await h.waitFor((m) => m.id === 2)
    expect(typeof sess.result.sessionId).toBe('string')
    h.send({
      jsonrpc: '2.0',
      id: 3,
      method: 'session/prompt',
      params: { sessionId: sess.result.sessionId, prompt: [{ type: 'text', text: 'hi' }] },
    })
    const chunk = await h.waitFor((m) => m.method === 'session/update')
    expect(chunk.params.update.sessionUpdate).toBe('agent_message_chunk')
    expect(chunk.params.update.content.text).toBe('echo:hi')
    const res = await h.waitFor((m) => m.id === 3)
    expect(res.result.stopReason).toBe('end_turn')
    h.finish()
    await h.done
  })

  it('rejects unknown methods with -32601', async () => {
    const h = harness(echoAgent)
    h.send({ jsonrpc: '2.0', id: 9, method: 'bogus/method', params: {} })
    const err = await h.waitFor((m) => m.id === 9)
    expect(err.error.code).toBe(-32601)
    h.finish()
    await h.done
  })

  it('session/cancel aborts a running prompt with stopReason cancelled', async () => {
    let cancelled = false
    const slow: AcpAgent = {
      run: (_text, _onChunk, signal) =>
        new Promise<void>((resolve) => {
          const t = setTimeout(resolve, 5000)
          signal.addEventListener('abort', () => {
            cancelled = true
            clearTimeout(t)
            resolve()
          })
        }),
    }
    const h = harness(slow)
    h.send({ jsonrpc: '2.0', id: 1, method: 'session/new', params: { cwd: '.' } })
    const sess = await h.waitFor((m) => m.id === 1)
    h.send({ jsonrpc: '2.0', id: 2, method: 'session/prompt', params: { sessionId: sess.result.sessionId, prompt: [{ type: 'text', text: 'slow' }] } })
    h.send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: sess.result.sessionId } })
    const res = await h.waitFor((m) => m.id === 2)
    expect(res.result.stopReason).toBe('cancelled')
    expect(cancelled).toBe(true)
    h.finish()
    await h.done
  })

  it('runAcp resolves when the input ends', async () => {
    const h = harness(echoAgent)
    h.finish()
    await expect(h.done).resolves.toBeUndefined()
  })
})
```

- [ ] **Step 2: Jalankan, pastikan RED**

Run: `npx vitest run test/acp.test.ts`
Expected: FAIL — `../src/acp` tidak ada.

- [ ] **Step 3: Implementasi** — `src/acp.ts`:

```ts
import type { Readable, Writable } from 'node:stream'

export const ACP_PROTOCOL_VERSION = 1

export interface AcpAgent {
  run(text: string, onChunk: (text: string) => void, signal: AbortSignal): Promise<void>
}

interface Session {
  controller: AbortController | null
}

export function runAcp(
  input: Readable | NodeJS.ReadableStream,
  output: Writable | NodeJS.WritableStream,
  opts: { cwd: string; newAgent: (cwd: string) => AcpAgent },
): Promise<void> {
  const sessions = new Map<string, Session>()
  let nextSession = 1
  const write = (msg: unknown) => {
    output.write(`${JSON.stringify(msg)}\n`)
  }
  const reply = (id: unknown, result: unknown) => write({ jsonrpc: '2.0', id, result })
  const replyError = (id: unknown, code: number, message: string) => write({ jsonrpc: '2.0', id, error: { code, message } })

  const handle = async (msg: any): Promise<void> => {
    const { id, method, params } = msg ?? {}
    if (method === 'initialize') {
      return reply(id, {
        protocolVersion: ACP_PROTOCOL_VERSION,
        agentCapabilities: { loadSession: false, promptCapabilities: { image: false, audio: false, embeddedContext: false } },
      })
    }
    if (method === 'session/new') {
      const sessionId = `s${nextSession++}`
      sessions.set(sessionId, { controller: null })
      return reply(id, { sessionId })
    }
    if (method === 'session/cancel') {
      sessions.get(params?.sessionId)?.controller?.abort()
      return
    }
    if (method === 'session/prompt') {
      const session = sessions.get(params?.sessionId)
      if (!session) return replyError(id, -32602, 'Unknown session')
      const text = (params?.prompt ?? [])
        .filter((p: any) => p?.type === 'text')
        .map((p: any) => String(p.text ?? ''))
        .join('\n')
      const controller = new AbortController()
      session.controller = controller
      let cancelled = false
      controller.signal.addEventListener('abort', () => {
        cancelled = true
      })
      try {
        const agent = opts.newAgent(params?.cwd ?? opts.cwd)
        await agent.run(text, (chunk) => {
          write({
            jsonrpc: '2.0',
            method: 'session/update',
            params: { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: chunk } } },
          })
        }, controller.signal)
      } catch (e) {
        return replyError(id, -32603, (e as Error).message)
      } finally {
        session.controller = null
      }
      return reply(id, { stopReason: cancelled ? 'cancelled' : 'end_turn' })
    }
    if (id !== undefined) return replyError(id, -32601, 'Method not found')
  }

  return new Promise<void>((resolve) => {
    let buf = ''
    const onData = (chunk: Buffer | string) => {
      buf += chunk.toString()
      let idx: number
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx)
        buf = buf.slice(idx + 1)
        if (!line.trim()) continue
        let msg: unknown
        try {
          msg = JSON.parse(line)
        } catch {
          continue
        }
        void handle(msg)
      }
    }
    const onEnd = () => {
      input.removeListener('data', onData)
      resolve()
    }
    input.on('data', onData)
    input.on('end', onEnd)
  })
}

/** Production agent: one bccli runtime per ACP session, permissions allowAll (the editor mediates). */
export function runtimeAgent(cwd: string): AcpAgent {
  return {
    async run(text, onChunk, signal) {
      const { parseCliArgs } = await import('./args')
      const { createRuntime } = await import('./setup')
      const rt = createRuntime({ cwd, args: { ...parseCliArgs([]), allowAll: true } })
      let out = ''
      rt.agent.onEvent = (event) => {
        if (event.type === 'text') {
          out += event.delta
          onChunk(event.delta)
        }
      }
      await rt.agent.run(text, signal)
      void out
    },
  }
}
```

`src/args.ts`:
- Union `command`: tambah `'acp'`.
- Di parser (ikuti cara `'update'`/`'models'` dikenali — cari `command = 'update'`): token argv `acp` → `command = 'acp'`.
- HELP EN (setelah baris `bccli update`): `  bccli acp                     run as an ACP agent for editors (Zed, ...)` — JAGA kolom deskripsi (kolom 32, sama dengan baris lain).

`src/i18n/id.ts`: key HELP EN baru → nilai ID identik dengan baris `  bccli acp                     jalankan sebagai agen ACP untuk editor (Zed, ...)`.

`src/cli.ts` (ikuti pola dispatch `update`):

```ts
if (args.command === 'acp') {
  const { runAcp, runtimeAgent } = await import('./acp')
  await runAcp(process.stdin, process.stdout, { cwd, newAgent: (c) => runtimeAgent(c) })
  return 0
}
```

(sesuaikan dengan bentuk fungsi dispatch yang ada — cek apakah handler mengembalikan exit code number; samakan.)

- [ ] **Step 4: Jalankan, pastikan GREEN + i18n**

Run: `npx vitest run test/acp.test.ts test/args.test.ts test/i18n.test.ts`
Expected: PASS (i18n memaksa key HELP sinkron EN/ID).

- [ ] **Step 5: Commit**

```bash
git add src/acp.ts src/args.ts src/cli.ts src/i18n/id.ts test/acp.test.ts
git commit -m "feat: minimal ACP agent server (bccli acp) for editor integrations"
```

---

### Task 8: Gates penuh, canary live, AGENTS.md, laporan (TANPA rilis)

**Files:**
- Modify: `C:\Users\farij\.config\opencode\AGENTS.md` (section BCCLI)

- [ ] **Step 1: Gates penuh 2×**

Run: `npx tsc --noEmit -p tsconfig.json; npm run lint; npm test; npm run build` lalu ulangi `npm test`.
Expected: tsc 0, lint 0, semua test pass (jumlah naik dari 554), build OK, stabil 2×.

- [ ] **Step 2: Canary live (sandbox BCCLI_HOME, model gmi murah)**

Setup: `$env:BCCLI_HOME = "$env:TEMP\bccli-f2"`; config.json berisi provider gmi (copy pola `~/.bccli/config.json` TANPA mencetak credentials; model flash termurah).

1. repo_map tool: `node dist\cli.js -p "Call the repo_map tool, then reply with only the number of files it listed." --allow-all` di sebuah repo kecil → jawaban angka; bukti map ada di output stream-json (`--output-format stream-json` → cari `"name":"repo_map"`).
2. theme: config `{"theme":"mono"}` → jalankan TUI sebentar via pywinpty, assert frame tidak mengandung warna ANSI (`\x1b[3`) ATAU lebih gampang: `node -e "import('./dist/cli.js')"` tidak praktis — cukup unit + ConPTY screenshot frame mono (tanpa escape color).
3. vim: config `{"editor":"vim"}` + driver ConPTY (`%TEMP%\opencode\pty-drive-local.py`): kirim `hi`, Esc, `x` → layar berisi `h` dan `NORMAL`; Enter chunk terpisah (gotcha lama).
4. sandbox: config `{"sandbox":"on"}` → `node dist\cli.js -p "Use the bash tool to run echo hi" --allow-all` di Windows → output tool berisi pesan sandbox tidak didukung (exit 1 dari run) — canary negatif yang diharapkan; argv-mode sudah diuji unit.
5. diagnostics: config `{"lsp":{"servers":[{"extensions":[".ts"],"command":"node","args":["<abs path test/fixtures/fake-lsp.mjs>"]}]}}` → `-p "Run the diagnostics tool on file canary.ts (create it first with the write tool), then reply DONE." --allow-all` di cwd sementara berisi `canary.ts` → bukti `fake problem` di stream-json.
6. SDK: `node -e "import('file:///<repo>/dist/sdk.js').then(async (m) => { const r = await m.runTask({ prompt: 'Reply with exactly SDK_OK', cwd: process.cwd(), env: { ...process.env, BCCLI_HOME: '<home canary>' } }); console.log('SDK:', r.text.trim(), r.stopReason); process.exit(r.text.includes('SDK_OK') ? 0 : 1) })"` → `SDK: SDK_OK done` exit 0.
7. ACP: `echo.` pipeline PowerShell merusak newline — pakai node: `node -e "const {spawn}=require('child_process'); const p=spawn(process.execPath,['dist/cli.js','acp']); let out=''; p.stdout.on('data',d=>{out+=d; if(out.includes('protocolVersion')){console.log('ACP_OK'); p.kill(); process.exit(0)}}); p.stdin.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{}})+'\n'); setTimeout(()=>{console.log('ACP_TIMEOUT',out);process.exit(1)},10000)"` → `ACP_OK`.

Bersihkan semua home/cwd canary sesudahnya.

- [ ] **Step 3: Update AGENTS.md** (opencode global) — ringkas: fitur Fase 2 + commit hashes, interface utama per modul, canary hasil, gotcha baru, status "Fase 3 belum; rilis ditahan; OAuth provider (#11) ditunda ke Fase 3".

- [ ] **Step 4: Laporan akhir ke user** — tabel fitur/canary, gates, daftar commit, deviasi (#11 ditunda), pertanyaan: lanjut Fase 3 atau rilis beta.39+Fase2?

- [ ] **Step 5: Commit terakhir bila ada perubahan sisa**

```bash
git status --short  # harus bersih (kecuali docs plan)
git add docs/superpowers/plans/2026-10-07-fase2-*.md
git commit -m "docs: fase 2 implementation plan"
```

---

## Self-Review Checklist (diisi penulis plan)

1. **Spec coverage:** repo map (T1), themes (T2), vim (T3), sandbox (T4), LSP (T5), SDK (T6), ACP (T7), gates/canary/docs (T8). OAuth provider #11 → deviasi eksplisit di header (tunda Fase 3).
2. **Placeholder scan:** tidak ada TBD/TODO. Dua titik menuntut verifikasi signature saat eksekusi dan sudah diberi instruksi eksplisit: (a) Task 5 — cek signature `resolvePath` di `src/tools/paths.ts` dan bentuk ctx `defineTool`; (b) Task 6 — cek nama field AgentEvent (`toolStart.id/name/input`, `toolEnd.id/output/isError`) di `src/agent.ts` dan sesuaikan switch SDK.
3. **Type consistency:** `VimMode/applyVim` (T3) dipakai PromptInput; `LspServer` didefinisikan di `src/lsp.ts` (T5) dan diimpor config/tools; `AcpAgent/runAcp` (T7) dipakai cli; `SdkOptions/SdkEvent` (T6) konsisten antara test dan implementasi. `estimateTokens` (T1) = signature nyata di `src/tokenBudget.ts:4`.
