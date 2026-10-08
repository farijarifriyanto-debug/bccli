# `bccli plugins` (npm marketplace) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** perintah `bccli plugins install|remove|list|update` yang mengelola plugin npm di prefix terkelola `~/.bccli/plugins/` dan menyinkronkan entry `plugins[]` global config — dengan 5 aturan wajib user (validasi spec ketat, idempoten, kelola hanya entry terkelola, config atomik + remediasi kegagalan parsial, update-all tidak mengaktifkan plugin nonaktif).

**Architecture:** dua modul murni baru (`src/pluginSpec.ts` parse/entry, `src/config.ts` helper config atomik) + `src/pluginsCli.ts` (dispatcher aksi dengan deps injection `runNpm`/`readPlugins`/`savePlugins` — tanpa npm nyata di test) + wiring `args.ts`/`cli.ts`/`i18n/id.ts` mengikuti pola subcommand `mcp`.

**Tech Stack:** Node ≥22, TypeScript strict, `node:fs`/`node:child_process` (polа spawn persis `src/update.ts`), vitest 5, **tanpa dependency baru**.

**Spec:** `docs/superpowers/specs/2026-10-07-plugins-marketplace-design.md`

## Global Constraints

- **EKSEKUSI DITAHAN**: jangan commit/push/npm-install-nyata sampai user menyetujui plan ini (ucapan user: "Jangan implementasikan kode, menjalankan npm install nyata, commit, atau push dulu"). Setelah approval, eksekusi TDD per task dengan commit lokal per task.
- 5 aturan user (spec §3, §5–§8) adalah kontrak test — setiap aturan punya tes eksplisit.
- Semua string user-facing lewat `t('...')` + key EN di `src/i18n/id.ts` (test i18n menjaga paritas; HELP = SATU key template byte-identik EN, nilai ID di `id.ts`).
- Suite vitest berbahasa Indonesia (`test/setup.ts` → `setLanguage('id')`). File dengan assertion teks katalog EN (`test/pluginsCli.test.ts`) WAJIB pin bahasa sendiri: `beforeAll(setLanguage('en'))` + `afterAll(setLanguage('id'))` (revisi #3); test lain memakai assertion lintas-bahasa (regex/token).
- Test TANPA npm nyata: `runNpm` di-inject (capture argv); npm sungguhan hanya di canary bertanda DITAHAN.
- Loader `src/plugins.ts` TIDAK diubah (resolusi `startsWith('.') → join(home, spec)` dipakai apa adanya).
- Edit file HANYA via tool edit/write (PowerShell `Set-Content` merusak UTF-8).
- Gates per task: `npx tsc --noEmit -p tsconfig.json` 0; `npm run lint` 0/0; `npm test` hijau.

---

### Task 1: config global atomik — `updateGlobalConfig` + `readGlobalPlugins`

**Files:**
- Modify: `src/config.ts` (tambah fungsi export; baca pola `readJsonConfig`/`bccliHome` yang ada)
- Test: `test/configAtomic.test.ts`

**Interfaces:**
- Consumes: `bccliHome(env)`, `readJsonConfig` (private config.ts), pola `writeFileSync` mode.
- Produces (dipakai Task 3):
  - `export function globalConfigPath(env: NodeJS.ProcessEnv = process.env): string`
  - `export function readGlobalPlugins(env: NodeJS.ProcessEnv = process.env): string[]` — baca mentah `config.json.plugins`; file tak ada → `[]`; bukan array string → `ConfigError(t('plugins must be an array of strings.'))` (samakan semantik `resolvedPlugins`).
  - `export function updateGlobalConfig(env: NodeJS.ProcessEnv, mutate: (cfg: Record<string, unknown>) => void): void` — read-modify-write **atomik** (tmp + rename).

- [ ] **Step 1: Test gagal** — `test/configAtomic.test.ts`:

```ts
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { globalConfigPath, readGlobalPlugins, updateGlobalConfig } from '../src/config'

const env = () => ({ BCCLI_HOME: mkdtempSync(join(tmpdir(), 'bccli-cfg-')) } as NodeJS.ProcessEnv)

test('updateGlobalConfig: file belum ada → dibuat dengan hasil mutate', () => {
  const e = env()
  updateGlobalConfig(e, (cfg) => {
    cfg.plugins = ['./plugins/node_modules/foo']
  })
  const raw = JSON.parse(readFileSync(globalConfigPath(e), 'utf8')) as Record<string, unknown>
  expect(raw.plugins).toEqual(['./plugins/node_modules/foo'])
})

test('updateGlobalConfig: kunci lain dipertahankan', () => {
  const e = env()
  writeFileSync(globalConfigPath(e), JSON.stringify({ model: 'gmi/x', providers: { gmi: {} }, plugins: ['./a'] }))
  updateGlobalConfig(e, (cfg) => {
    ;(cfg.plugins as string[]).push('./b')
  })
  const raw = JSON.parse(readFileSync(globalConfigPath(e), 'utf8')) as Record<string, unknown>
  expect(raw).toMatchObject({ model: 'gmi/x', providers: { gmi: {} }, plugins: ['./a', './b'] })
})

test('updateGlobalConfig: mutate throw → file tidak berubah, tidak ada sisa .tmp', () => {
  const e = env()
  writeFileSync(globalConfigPath(e), JSON.stringify({ plugins: ['./keep'] }))
  expect(() =>
    updateGlobalConfig(e, () => {
      throw new Error('boom')
    }),
  ).toThrow('boom')
  expect(JSON.parse(readFileSync(globalConfigPath(e), 'utf8'))).toEqual({ plugins: ['./keep'] })
  expect(readdirSync(join(e.BCCLI_HOME as string)).filter((f) => f.includes('.tmp'))).toEqual([])
})

test('updateGlobalConfig sukses tidak meninggalkan file .tmp', () => {
  const e = env()
  updateGlobalConfig(e, (cfg) => {
    cfg.plugins = []
  })
  expect(readdirSync(join(e.BCCLI_HOME as string)).filter((f) => f.includes('.tmp'))).toEqual([])
  expect(existsSync(globalConfigPath(e))).toBe(true)
})

test('readGlobalPlugins: file tak ada → []; tipe salah → ConfigError', () => {
  const e = env()
  expect(readGlobalPlugins(e)).toEqual([])
  writeFileSync(globalConfigPath(e), JSON.stringify({ plugins: 'nope' }))
  expect(() => readGlobalPlugins(e)).toThrow(/plugins/)
})
```

- [ ] **Step 2: RED** — `npx vitest run test/configAtomic.test.ts` → module tidak ada.

- [ ] **Step 3: Implementasi** — di `src/config.ts` (letakkan dekat `loadConfig`):

```ts
export function globalConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(bccliHome(env), 'config.json')
}

export function readGlobalPlugins(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = readJsonConfig(globalConfigPath(env)) as { plugins?: unknown }
  const value = raw.plugins
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new ConfigError(t('plugins must be an array of strings.'))
  }
  return value as string[]
}

function writeFileAtomic(path: string, data: string): void {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
  try {
    writeFileSync(tmp, data)
    renameSync(tmp, path)
  } catch (error) {
    try {
      rmSync(tmp, { force: true })
    } catch {}
    throw error
  }
}

/**
 * Read-modify-write of the global config.json. `mutate` throwing aborts before
 * any write; the write itself is atomic (tmp + rename) so a crash never leaves
 * a truncated config.
 */
export function updateGlobalConfig(env: NodeJS.ProcessEnv, mutate: (cfg: Record<string, unknown>) => void): void {
  const path = globalConfigPath(env)
  let cfg: Record<string, unknown> = {}
  if (existsSync(path)) {
    cfg = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  }
  mutate(cfg)
  mkdirSync(dirname(path), { recursive: true })
  writeFileAtomic(path, `${JSON.stringify(cfg, null, 2)}\n`)
}
```

Tambah import `renameSync`, `rmSync`, `dirname` bila belum ada (cek import baris 1 config.ts). `JSON.parse` gagal (config korup) → propagasi SyntaxError — biarkan (fail loud; pesan dari JSON).

- [ ] **Step 4: GREEN** — `npx vitest run test/configAtomic.test.ts`.
- [ ] **Step 5: Gate** — tsc + lint (JANGAN commit dulu — lihat Global Constraints).

---

### Task 2: `src/pluginSpec.ts` — validasi spec + helper entry (Aturan 1)

**Files:**
- Create: `src/pluginSpec.ts`
- Test: `test/pluginSpec.test.ts`

**Interfaces:**
- Consumes: tidak ada (modul murni).
- Produces (dipakai Task 3 + 4):
  - `export interface ParsedSpec { name: string; spec: string }`
  - `export function parseNpmSpec(raw: string): ParsedSpec | null`
  - `export function managedEntry(name: string): string` → `./plugins/node_modules/<name>`
  - `export function isManagedEntry(entry: string): boolean`
  - `export function managedEntryName(entry: string): string | null` — prefix canonical +
    sufiks hanya nama paket npm polos (tanpa versi/tag); `null` = entry malformed yang
    TIDAK boleh diteruskan ke npm

- [ ] **Step 1: Test gagal** — `test/pluginSpec.test.ts`:

```ts
import { expect, test } from 'vitest'
import { isManagedEntry, managedEntry, managedEntryName, parseNpmSpec } from '../src/pluginSpec'

test('Aturan 1: spec valid diterima', () => {
  expect(parseNpmSpec('foo')).toEqual({ name: 'foo', spec: 'foo' })
  expect(parseNpmSpec('@scope/bar')).toEqual({ name: '@scope/bar', spec: '@scope/bar' })
  expect(parseNpmSpec('foo@1.2.3')).toEqual({ name: 'foo', spec: 'foo@1.2.3' })
  expect(parseNpmSpec('foo@2.0.0-beta.1')).toEqual({ name: 'foo', spec: 'foo@2.0.0-beta.1' })
  expect(parseNpmSpec('foo@latest')).toEqual({ name: 'foo', spec: 'foo@latest' })
  expect(parseNpmSpec('@scope/bar@1.0.0')).toEqual({ name: '@scope/bar', spec: '@scope/bar@1.0.0' })
  expect(parseNpmSpec(' foo ')).toEqual({ name: 'foo', spec: 'foo' }) // trim ramah shell
})

test('Aturan 1: URL/git/path/flag/metachar/kapital/range ditolak', () => {
  for (const bad of [
    'https://evil.com/x.tgz',
    'git+ssh://git@host/r.git',
    'github:a/b',
    'file:./local',
    './local',
    '../up',
    '/abs/path',
    '-f',
    '--global',
    'foo;rm -rf',
    'foo bar',
    'FOO',
    '@scope',
    '@scope/',
    'foo@^1.2.0',
    'foo@~1',
    '',
  ]) {
    expect(parseNpmSpec(bad), bad).toBeNull()
  }
})

test('managedEntry / isManagedEntry', () => {
  expect(managedEntry('foo')).toBe('./plugins/node_modules/foo')
  expect(managedEntry('@scope/bar')).toBe('./plugins/node_modules/@scope/bar')
  expect(isManagedEntry('./plugins/node_modules/foo')).toBe(true)
  expect(isManagedEntry('./plugins/node_modules/@a/b')).toBe(true)
  expect(isManagedEntry('/abs/manual')).toBe(false)
  expect(isManagedEntry('./other/path')).toBe(false)
  expect(isManagedEntry('./plugins/node_modulesX/evil')).toBe(false) // prefix-presisi
})

test('managedEntryName: valid → nama polos; malformed → null (tabel traversal/flag/metachar/scope/versi)', () => {
  expect(managedEntryName('./plugins/node_modules/foo')).toBe('foo')
  expect(managedEntryName('./plugins/node_modules/@scope/bar')).toBe('@scope/bar')
  for (const bad of [
    './plugins/node_modules/../x', // traversal
    './plugins/node_modules/foo/../bar', // traversal internal
    './plugins/node_modules/-f', // flag
    './plugins/node_modules/--global',
    './plugins/node_modules/foo;rm', // metachar
    './plugins/node_modules/foo bar',
    './plugins/node_modules/foo@1.2.3', // sufiks versi di entry = malformed
    './plugins/node_modules/foo@latest', // sufiks tag
    './plugins/node_modules/FOO', // kapital
    './plugins/node_modules/@scope/bar@1.0.0',
    './plugins/node_modules/./x',
    './plugins/node_modules/',
  ]) {
    expect(managedEntryName(bad), bad).toBeNull()
  }
  expect(managedEntryName('/abs/manual')).toBeNull() // non-terelola → null (bukan malformed-terelola)
  expect(managedEntryName('./other/path')).toBeNull()
})
```

- [ ] **Step 2: RED** — `npx vitest run test/pluginSpec.test.ts`.

- [ ] **Step 3: Implementasi** — `src/pluginSpec.ts`:

```ts
/** Strict npm spec: name | @scope/name | name@version | name@tag (lowercase only). */
const NPM_SPEC_RE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:@[a-z0-9][a-z0-9._+-]*)?$/

const MANAGED_PREFIX = './plugins/node_modules/'

export interface ParsedSpec {
  /** Package name without the @version/@tag suffix; scope preserved. */
  name: string
  /** The original (trimmed) spec, safe to hand to npm argv. */
  spec: string
}

export function parseNpmSpec(raw: string): ParsedSpec | null {
  const spec = raw.trim()
  if (!NPM_SPEC_RE.test(spec)) return null
  const at = spec.lastIndexOf('@')
  const name = at > 0 ? spec.slice(0, at) : spec
  if (!NPM_SPEC_RE.test(name)) return null
  return { name, spec }
}

export function managedEntry(name: string): string {
  return `${MANAGED_PREFIX}${name}`
}

export function isManagedEntry(entry: string): boolean {
  return entry.startsWith(MANAGED_PREFIX)
}

/** Bare npm package name only — no version/tag suffix, no traversal/flags/metachars. */
const BARE_NAME_RE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/

/**
 * Strict validation of a managed entry: canonical prefix + bare npm name suffix.
 * Returns the bare name, or null when the entry is not managed or is malformed
 * (malformed entries must never be handed to npm).
 */
export function managedEntryName(entry: string): string | null {
  if (!isManagedEntry(entry)) return null
  const rest = entry.slice(MANAGED_PREFIX.length)
  return BARE_NAME_RE.test(rest) ? rest : null
}
```

(Catatan: `foo@1.2.3` → `lastIndexOf('@') > 0` memotong suffix; `@scope/bar` sendiri → `at === 0` → name utuh; `@scope/bar@1.0.0` → `at > 0` (indeks akhir) ✓. Validasi ganda `name` menangkap kasus aneh seperti suffix menghasilkan nama invalid.)

- [ ] **Step 4: GREEN** — `npx vitest run test/pluginSpec.test.ts`.
- [ ] **Step 5: Gate** — tsc + lint (belum commit).

---

### Task 3: `src/pluginsCli.ts` — dispatcher aksi + deps injection (Aturan 2–5)

**Files:**
- Create: `src/pluginsCli.ts`
- Test: `test/pluginsCli.test.ts`

**Interfaces:**
- Consumes: Task 1 (`readGlobalPlugins`, `updateGlobalConfig`), Task 2 (`parseNpmSpec`, `managedEntry`, `isManagedEntry`), `CliArgs` (Task 4 mengisi `subArgs`), `ConfigError`/`t`.
- Produces (dipakai Task 4):
  - ```ts
    export interface PluginsDeps {
      out(s: string): void
      err(s: string): void
      env: NodeJS.ProcessEnv
      /** argv = argumen setelah npm (mis. ['install','foo']). Prefix = <home>/plugins. */
      runNpm(prefix: string, argv: string[]): Promise<{ code: number; stderr: string }>
      readPlugins(): string[]
      savePlugins(entries: string[]): void
    }
    export function ensurePrefixDir(prefix: string): void
    export async function runPluginsCommand(args: CliArgs, deps: PluginsDeps): Promise<number>
    ```
  - Exit codes: 0 sukses / 1 semua kegagalan (spec §2).

- [ ] **Step 1: Test gagal** — `test/pluginsCli.test.ts` (harness + semua kasus aturan):

```ts
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { parseCliArgs } from '../src/args'
import { bccliHome } from '../src/config'
import { setLanguage } from '../src/i18n'
import { type PluginsDeps, runPluginsCommand } from '../src/pluginsCli'

// Revisi #3: assertion memakai teks katalog EN → pin bahasa EKSPLISIT di file ini,
// pulihkan ke 'id' setelah tes (setup.ts menyetel 'id' per file; restore = jaring pengaman).
beforeAll(() => setLanguage('en'))
afterAll(() => setLanguage('id'))

function harness(over: Partial<PluginsDeps> = {}) {
  const home = mkdtempSync(join(tmpdir(), 'bccli-plg-'))
  const npmCalls: string[][] = []
  const outLines: string[] = []
  const errLines: string[] = []
  let plugins: string[] = []
  let saveCalls = 0
  const deps: PluginsDeps = {
    out: (s) => outLines.push(s),
    err: (s) => errLines.push(s),
    env: { BCCLI_HOME: home } as NodeJS.ProcessEnv,
    runNpm: async (prefix, argv) => {
      npmCalls.push([prefix, ...argv])
      return { code: 0, stderr: '' }
    },
    readPlugins: () => plugins,
    savePlugins: (entries) => {
      saveCalls++
      plugins = entries
    },
    ...over,
  }
  return { deps, npmCalls, outLines, errLines, getPlugins: () => plugins, setPlugins: (p: string[]) => (plugins = p), saveCount: () => saveCalls, home }
}

const run = (argv: string[], deps: PluginsDeps) => runPluginsCommand(parseCliArgs(argv), deps)
// Revisi #1: entry config = STRING canonical 'plugins/node_modules' (literal template);
// join() HANYA untuk path filesystem (prefix npm, paket di disk) — jangan dicampur.
const managed = (name: string): string => `./plugins/node_modules/${name}`

test('install valid → npm install + entry masuk (prefix <home>/plugins)', async () => {
  const h = harness()
  expect(await run(['plugins', 'install', 'foo@latest'], h.deps)).toBe(0)
  expect(h.npmCalls).toHaveLength(1)
  expect(h.npmCalls[0][0]).toBe(join(h.home, 'plugins'))
  expect(h.npmCalls[0].slice(1)).toEqual(['install', 'foo@latest'])
  expect(h.getPlugins()).toEqual([managed('foo')])
  expect(h.outLines.join('\n')).toContain('installed')
})

test('Aturan 2: install dua kali → 1 entry; kedua = already enabled, npm tetap jalan', async () => {
  const h = harness()
  await run(['plugins', 'install', 'foo'], h.deps)
  expect(await run(['plugins', 'install', 'foo'], h.deps)).toBe(0)
  expect(h.getPlugins()).toEqual([managed('foo')])
  expect(h.saveCount()).toBe(2) // tulis kedua = isi IDENTIK (bukan duplikat) — syarat kontrak §8 reinstall
  expect(h.outLines.join('\n')).toContain('already enabled')
  expect(h.npmCalls).toHaveLength(2)
})

test('Aturan 1: install spec invalid → exit 1, npm TIDAK dipanggil', async () => {
  const h = harness()
  expect(await run(['plugins', 'install', 'https://evil.com/x.tgz'], h.deps)).toBe(1)
  expect(h.npmCalls).toHaveLength(0)
  expect(h.errLines.join('\n')).toContain('Invalid npm package spec')
  expect(h.errLines.join('\n')).toContain('https://evil.com/x.tgz')
})

test('npm gagal → exit 1, config tidak disentuh', async () => {
  const h = harness({
    runNpm: async () => ({ code: 1, stderr: 'E404 Not Found' }),
  })
  expect(await run(['plugins', 'install', 'nope'], h.deps)).toBe(1)
  expect(h.saveCount()).toBe(0)
  expect(h.errLines.join('\n')).toContain('npm install failed')
  expect(h.errLines.join('\n')).toContain('E404')
})

test('Aturan 4-5a (install baru): savePlugins throw → exit 1, pesan NOT enabled + nama + entry + path', async () => {
  const h = harness({
    savePlugins: () => {
      throw new Error('EACCES: permission denied')
    },
  })
  expect(await run(['plugins', 'install', 'foo'], h.deps)).toBe(1)
  const text = h.errLines.join('\n')
  expect(text).toContain('NOT enabled')
  expect(text).toContain('foo')
  expect(text).toContain(managed('foo'))
  expect(text).toContain('config.json')
  expect(text).toContain('EACCES')
  expect(h.getPlugins()).toEqual([]) // entry tidak terdaftar (transisi 1)
  expect(h.npmCalls).toHaveLength(1) // npm sudah sukses sebelum config gagal
})

test('Aturan 4-5b (reinstall terdaftar): savePlugins throw → exit 1, pesan stays enabled, entry TETAP', async () => {
  const h = harness({
    savePlugins: () => {
      throw new Error('ENOSPC: no space left on device')
    },
  })
  h.setPlugins([managed('foo')])
  expect(await run(['plugins', 'install', 'foo'], h.deps)).toBe(1)
  const text = h.errLines.join('\n')
  expect(text).toContain('stays enabled')
  expect(text).toContain('existing entry')
  expect(text).toContain('config.json')
  expect(text).toContain('ENOSPC')
  expect(text).not.toContain('NOT enabled') // BEDA dari transisi 1
  expect(h.getPlugins()).toEqual([managed('foo')]) // entry lama utuh & tetap aktif
  expect(h.outLines.join('\n')).not.toContain('already enabled') // gagal sebelum output sukses
})

test('Aturan 4-5c (remove): npm uninstall sukses + savePlugins throw → exit 1, entry TERTINGGAL + peringatan start', async () => {
  const h = harness({
    savePlugins: () => {
      throw new Error('EACCES: permission denied')
    },
  })
  h.setPlugins([managed('foo')])
  expect(await run(['plugins', 'remove', 'foo'], h.deps)).toBe(1)
  expect(h.npmCalls[0].slice(1)).toEqual(['uninstall', 'foo']) // npm sudah jalan
  const text = h.errLines.join('\n')
  expect(text).toContain('remains')
  expect(text).toContain('refuse to start') // peringatan loader Plugin-not-found
  expect(text).toContain(managed('foo'))
  expect(text).toContain('config.json')
  expect(h.getPlugins()).toEqual([managed('foo')]) // entry tertinggal (transisi 3)
  // list tetap jalan dan menandainya resolve-gagal (✗ = file hilang)
  expect(await run(['plugins', 'list'], h.deps)).toBe(0)
  expect(h.outLines.join('\n')).toMatch(/✗.*foo/)
})

test('remove entry terelola → npm uninstall + entry hilang', async () => {
  const h = harness()
  h.setPlugins([managed('foo')])
  expect(await run(['plugins', 'remove', 'foo'], h.deps)).toBe(0)
  expect(h.npmCalls[0].slice(1)).toEqual(['uninstall', 'foo'])
  expect(h.getPlugins()).toEqual([])
  expect(h.outLines.join('\n')).toContain('removed')
})

test('Aturan 3: remove entry manual → tolak, tanpa npm', async () => {
  const h = harness()
  h.setPlugins(['/abs/manual-plugin'])
  expect(await run(['plugins', 'remove', '/abs/manual-plugin'], h.deps)).toBe(1)
  expect(h.npmCalls).toHaveLength(0)
  expect(h.errLines.join('\n')).toContain('manual plugin entry')
  expect(h.getPlugins()).toEqual(['/abs/manual-plugin'])
})

test('remove nama tak terpasang → exit 1 tanpa npm; arg aneh → Unknown plugin', async () => {
  const h = harness()
  expect(await run(['plugins', 'remove', 'ghost'], h.deps)).toBe(1)
  expect(h.npmCalls).toHaveLength(0)
  expect(h.errLines.join('\n')).toContain('not an installed managed plugin')
  expect(await run(['plugins', 'remove', 'Weird Arg!'], h.deps)).toBe(1)
  expect(h.errLines.join('\n')).toContain('Unknown plugin')
})

test('Aturan 3: update entry manual → tolak; update nama valid terelola → npm <nama>@latest tanpa tulis config', async () => {
  const h = harness()
  h.setPlugins(['/abs/manual', managed('foo')])
  expect(await run(['plugins', 'update', '/abs/manual'], h.deps)).toBe(1)
  expect(h.npmCalls).toHaveLength(0)
  expect(await run(['plugins', 'update', 'foo'], h.deps)).toBe(0)
  expect(h.npmCalls[0].slice(1)).toEqual(['install', 'foo@latest'])
  expect(h.saveCount()).toBe(0) // update tidak pernah menulis config
  expect(h.getPlugins()).toEqual(['/abs/manual', managed('foo')])
})

test('Aturan 5: update-all hanya entry di config; files-only (nonaktif) TIDAK disentuh', async () => {
  const h = harness()
  h.setPlugins([managed('pkga')])
  mkdirSync(join(h.home, 'plugins', 'node_modules', 'pkgb'), { recursive: true }) // files ada, entry TIDAK
  expect(await run(['plugins', 'update'], h.deps)).toBe(0)
  expect(h.npmCalls.map((c) => c.slice(1))).toEqual([['install', 'pkga@latest']])
  expect(h.getPlugins()).toEqual([managed('pkga')]) // pkgb tidak diaktifkan
  expect(h.saveCount()).toBe(0)
})

test('update-all tanpa entry terelola → pesan, exit 0, tanpa npm', async () => {
  const h = harness()
  h.setPlugins(['/abs/manual'])
  expect(await run(['plugins', 'update'], h.deps)).toBe(0)
  expect(h.npmCalls).toHaveLength(0)
  expect(h.outLines.join('\n')).toContain('No managed plugins')
})

test('list: tampilkan semua entry (managed ✓+versi, manual, missing ✗)', async () => {
  const h = harness()
  h.setPlugins([managed('foo'), '/abs/manual', managed('missing')])
  mkdirSync(join(h.home, 'plugins', 'node_modules', 'foo'), { recursive: true })
  writeFileSync(join(h.home, 'plugins', 'node_modules', 'foo', 'package.json'), JSON.stringify({ name: 'foo', version: '1.2.3' }))
  expect(await run(['plugins', 'list'], h.deps)).toBe(0)
  const text = h.outLines.join('\n')
  expect(text).toContain('1.2.3')
  expect(text).toContain('(manual)')
  expect(text).toContain('missing')
  expect(text).toMatch(/✗.*missing/)
})

test('install tanpa spec → exit 1 + usage; aksi tak dikenal → exit 1 + usage', async () => {
  const h = harness()
  expect(await run(['plugins', 'install'], h.deps)).toBe(1)
  expect(h.errLines.join('\n')).toContain('install requires a package spec')
  expect(await run(['plugins', 'bogus'], h.deps)).toBe(1)
  expect(h.errLines.join('\n')).toContain('Unknown action')
})

test('Revisi #1: env TANPA BCCLI_HOME → prefix npm = bccliHome() default (bukan path relatif)', async () => {
  const h = harness()
  h.setPlugins([managed('foo')])
  const bare = { ...h.deps, env: {} as NodeJS.ProcessEnv } // fake config-io → home asli tak tersentuh
  expect(await run(['plugins', 'remove', 'foo'], bare)).toBe(0)
  expect(h.npmCalls[0][0]).toBe(join(bccliHome({} as NodeJS.ProcessEnv), 'plugins'))
  expect(h.npmCalls[0][0]).toBe(join(homedir(), '.bccli', 'plugins'))
  expect(h.npmCalls[0][0]).not.toBe('plugins') // guard terhadap pola BCCLI_HOME ?? ''
})

test('Revisi #2: entry malformed → remove tolak TANPA npm, pesan Malformed managed entry', async () => {
  const h = harness()
  const evil = './plugins/node_modules/../evil'
  h.setPlugins([evil])
  expect(await run(['plugins', 'remove', evil], h.deps)).toBe(1)
  expect(h.npmCalls).toHaveLength(0)
  expect(h.errLines.join('\n')).toContain('Malformed managed entry')
  expect(h.errLines.join('\n')).toContain('will not pass it to npm')
  expect(h.getPlugins()).toEqual([evil]) // entry tidak dihapus
})

test('Revisi #2+#7: update-all → malformed dilewati + peringatan + exit 1; npm hanya nama valid', async () => {
  const h = harness()
  h.setPlugins([managed('pkga'), './plugins/node_modules/../evil'])
  expect(await run(['plugins', 'update'], h.deps)).toBe(1)
  expect(h.npmCalls.map((c) => c.slice(1))).toEqual([['install', 'pkga@latest']])
  expect(h.errLines.join('\n')).toContain('Skipping malformed entry')
  expect(h.getPlugins()).toEqual([managed('pkga'), './plugins/node_modules/../evil']) // config tak berubah
})

test('Revisi #4: read-failure SEBELUM npm → list/update/remove tanpa npm + pesan no changes', async () => {
  const boom = (): string[] => {
    throw new SyntaxError('Unexpected token in JSON')
  }
  const hl = harness({ readPlugins: boom })
  expect(await run(['plugins', 'list'], hl.deps)).toBe(1)
  expect(hl.errLines.join('\n')).toContain('while running list')
  expect(hl.errLines.join('\n')).toContain('no changes were made')
  expect(hl.npmCalls).toHaveLength(0)

  const hu = harness({ readPlugins: boom })
  expect(await run(['plugins', 'update'], hu.deps)).toBe(1)
  expect(hu.errLines.join('\n')).toContain('while running update')
  expect(hu.npmCalls).toHaveLength(0)

  const hr = harness({ readPlugins: boom })
  expect(await run(['plugins', 'remove', 'foo'], hr.deps)).toBe(1)
  expect(hr.errLines.join('\n')).toContain('while running remove')
  expect(hr.npmCalls).toHaveLength(0)
})

test('Revisi #4: read-failure SESUDAH npm — install → npm jalan + pesan entry list unchanged', async () => {
  const h = harness({
    readPlugins: () => {
      throw new SyntaxError('bad json')
    },
  })
  expect(await run(['plugins', 'install', 'foo'], h.deps)).toBe(1)
  expect(h.npmCalls).toHaveLength(1) // npm SUDAH jalan sebelum read gagal
  const text = h.errLines.join('\n')
  expect(text).toContain('config could not be read')
  expect(text).toContain('entry list is unchanged')
  expect(text).not.toContain('no changes were made') // BEDA dari read-SEBELUM
})

test('Revisi #4: read-failure SESUDAH npm — remove → read ke-2 gagal setelah uninstall, entry tidak dihapus', async () => {
  let n = 0
  const h = harness({
    readPlugins: () => {
      n++
      if (n === 1) return [managed('foo')] // resolveTarget (sebelum npm) sukses
      throw new SyntaxError('bad json') // baca saat menyusun entry baru (sesudah npm)
    },
  })
  expect(await run(['plugins', 'remove', 'foo'], h.deps)).toBe(1)
  expect(h.npmCalls[0].slice(1)).toEqual(['uninstall', 'foo'])
  const text = h.errLines.join('\n')
  expect(text).toContain('npm removed the files')
  expect(text).toContain('entry list is unchanged')
  expect(text).toContain('remove foo') // instruksi remove-ulang spesifik
  expect(text).not.toContain('no changes were made')
  expect(text).not.toContain('refuse to start') // BEDA dari write-failure transisi 3
})

test('Revisi #3: list resolusi sejajar loader — absolut ✓, relatif-home ✓ (manual), bare resolve ✓, tak-ada ✗, malformed (malformed)', async () => {
  const h = harness()
  const absDir = join(h.home, 'abs-manual')
  mkdirSync(absDir, { recursive: true })
  writeFileSync(join(absDir, 'package.json'), JSON.stringify({ name: 'abs-manual', version: '2.0.0' }))
  mkdirSync(join(h.home, 'rel-manual'), { recursive: true })
  writeFileSync(join(h.home, 'rel-manual', 'package.json'), JSON.stringify({ name: 'rel-manual', version: '0.9.0' }))
  h.setPlugins([absDir, './rel-manual', 'ws', 'paket-yang-tidak-ada-xyz', './plugins/node_modules/../evil'])
  expect(await run(['plugins', 'list'], h.deps)).toBe(0)
  const text = h.outLines.join('\n')
  expect(text).toContain('2.0.0') // absolut + versi
  expect(text).toContain('0.9.0') // relatif join(home, entry) + versi
  expect(text).toContain('(manual)')
  expect(text).toMatch(/✓.*\bws\b/) // bare spec resolve via createRequire (dep repo)
  expect(text).toMatch(/✗.*paket-yang-tidak-ada-xyz/)
  expect(text).toContain('(malformed)')
  // tanpa import/menjalankan plugin: list hanya existsSync + baca package.json (assert tidak throw)
})
```

- [ ] **Step 2: RED** — `npx vitest run test/pluginsCli.test.ts`.

- [ ] **Step 3: Implementasi** — `src/pluginsCli.ts`:

```ts
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join } from 'node:path'
import type { CliArgs } from './args'
import { bccliHome, globalConfigPath } from './config'
import { type ParsedSpec, isManagedEntry, managedEntry, managedEntryName, parseNpmSpec } from './pluginSpec'
import { t } from './i18n'

export interface PluginsDeps {
  out(s: string): void
  err(s: string): void
  env: NodeJS.ProcessEnv
  runNpm(prefix: string, argv: string[]): Promise<{ code: number; stderr: string }>
  readPlugins(): string[]
  savePlugins(entries: string[]): void
}

/** Minimal package.json so `npm install --prefix` behaves deterministically. */
export function ensurePrefixDir(prefix: string): void {
  mkdirSync(prefix, { recursive: true })
  const pkg = join(prefix, 'package.json')
  if (!existsSync(pkg)) {
    writeFileSync(pkg, `${JSON.stringify({ name: 'bccli-plugins', private: true, version: '0.0.0' }, null, 2)}\n`)
  }
}

export async function runPluginsCommand(args: CliArgs, deps: PluginsDeps): Promise<number> {
  const [action, target] = args.subArgs
  // Revisi #1: home SELALU via bccliHome(deps.env) — tanpa env → ~/.bccli, bukan ''.
  const prefix = join(bccliHome(deps.env), 'plugins')
  switch (action ?? 'list') {
    case 'list':
      return listAction(deps)
    case 'install':
      return installAction(target, deps, prefix)
    case 'remove':
      return removeAction(target, deps, prefix)
    case 'update':
      return updateAction(target, deps, prefix)
    default:
      deps.err(t('Unknown action: {action}. Use list, install <spec>, remove <name>, or update [name].', { action: action ?? '' }))
      return 1
  }
}
```

Isi aksi (fungsi lokal, urutan kontrol persis spec):

```ts
// Revisi #3: resolusi list SEJALUR dengan loadPlugins — tanpa import/eksekusi plugin.
const require_ = createRequire(import.meta.url) // base identik dgn dist/plugins.ts

function resolveEntryPath(entry: string, home: string): string | null {
  if (isAbsolute(entry)) return entry
  if (entry.startsWith('.')) return join(home, entry)
  try {
    return require_.resolve(entry) // bare spec — gagal → null (tak-terresolve), jangan throw
  } catch {
    return null
  }
}

function readFailure(action: 'list' | 'remove' | 'update', error: Error, deps: PluginsDeps): number {
  // Tahap SEBELUM npm: tidak ada perubahan apa pun.
  deps.err(
    t('Cannot read the plugin config while running {action}: {reason} at {path} — no changes were made; fix the config, then retry.', {
      action,
      reason: error.message,
      path: globalConfigPath(deps.env),
    }),
  )
  return 1
}

function listAction(deps: PluginsDeps): number {
  let entries: string[]
  try {
    entries = deps.readPlugins()
  } catch (error) {
    return readFailure('list', error as Error, deps)
  }
  const home = bccliHome(deps.env)
  for (const entry of entries) {
    const managed = isManagedEntry(entry)
    const bare = managed ? managedEntryName(entry) : entry
    const suffix = !managed ? ' (manual)' : bare === null ? ' (malformed)' : ''
    const resolved = resolveEntryPath(entry, home)
    if (!resolved || !existsSync(resolved)) {
      deps.out(`✗ ${entry}${suffix}`)
      continue
    }
    let version = ''
    try {
      const pkgPath = statSync(resolved).isDirectory() ? join(resolved, 'package.json') : join(dirname(resolved), 'package.json')
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string }
      if (pkg.version) version = ` (${pkg.version})`
    } catch {}
    deps.out(`✓ ${entry}${suffix}${version}`)
  }
  return 0
}

function npmFailure(res: { code: number; stderr: string }, deps: PluginsDeps): number {
  deps.err(t('npm install failed ({code}): {stderr}', { code: String(res.code), stderr: res.stderr.slice(-400) }))
  return 1
}

async function installAction(target: string | undefined, deps: PluginsDeps, prefix: string): Promise<number> {
  if (!target) {
    deps.err(t('install requires a package spec: bccli plugins install <spec>'))
    return 1
  }
  const parsed: ParsedSpec | null = parseNpmSpec(target)
  if (!parsed) {
    deps.err(
      t('Invalid npm package spec: {spec}. Use a name, @scope/name, name@version, or name@tag — URLs, git, paths, and flags are not accepted.', { spec: target }),
    )
    return 1
  }
  ensurePrefixDir(prefix)
  const res = await deps.runNpm(prefix, ['install', parsed.spec])
  if (res.code !== 0) return npmFailure(res, deps)
  const entry = managedEntry(parsed.name)
  let entries: string[]
  try {
    entries = deps.readPlugins()
  } catch (error) {
    // Kegagalan baca setelah npm sukses: daftar entry TIDAK berubah (transisi apa pun).
    deps.err(t('npm finished but the config could not be read: {reason} — the entry list is unchanged; fix {path}, then rerun the same command (safe to repeat).', { reason: (error as Error).message, path: globalConfigPath(deps.env) }))
    return 1
  }
  const wasRegistered = entries.includes(entry)
  try {
    // Aturan 2: includes-sebelum-append → duplikat mustahil; entry lama ditulis identik.
    deps.savePlugins(wasRegistered ? entries : [...entries, entry])
  } catch (error) {
    const reason = (error as Error).message
    // Aturan 4: dua PESAN BERBEDA untuk dua transisi (jangan disatukan).
    deps.err(
      wasRegistered
        ? t('npm finished but the config update failed: {reason}. {name} stays enabled through its existing entry {entry}; the package files may already be new. Fix the config error at {path} — no entry change was required.', { reason, name: parsed.name, entry, path: globalConfigPath(deps.env) })
        : t('npm finished but the config update failed: {reason}. {name} is installed but NOT enabled — fix the config error, then run "bccli plugins install {name}" again (safe to repeat), or add {entry} to {path} manually.', { reason, name: parsed.name, entry, path: globalConfigPath(deps.env) }),
    )
    return 1
  }
  deps.out(wasRegistered ? t('{name} is already enabled.', { name: parsed.name }) : t('{name} installed and enabled.', { name: parsed.name }))
  return 0
}

function resolveTarget(
  target: string | undefined,
  deps: PluginsDeps,
  action: 'remove' | 'update',
): { entry: string; name: string } | { error: string } | 'missing-arg' {
  if (!target) return 'missing-arg'
  let entries: string[]
  try {
    entries = deps.readPlugins()
  } catch (error) {
    // Tahap SEBELUM npm — tidak ada perubahan apa pun.
    return { error: t('Cannot read the plugin config while running {action}: {reason} at {path} — no changes were made; fix the config, then retry.', { action, reason: (error as Error).message, path: globalConfigPath(deps.env) }) }
  }
  if (entries.includes(target)) {
    if (isManagedEntry(target)) {
      const name = managedEntryName(target)
      if (!name) {
        // Revisi #2: entry malformed TIDAK PERNAH diteruskan ke npm.
        return { error: t('Malformed managed entry: {entry} — fix it manually in {path}; bccli will not pass it to npm.', { entry: target, path: globalConfigPath(deps.env) }) }
      }
      return { entry: target, name }
    }
    return { error: t('{entry} is a manual plugin entry — edit the global config.json directly to remove it.', { entry: target }) }
  }
  const parsed = parseNpmSpec(target)
  if (parsed) {
    const entry = managedEntry(parsed.name)
    if (entries.includes(entry)) return { entry, name: parsed.name }
    return { error: t('{name} is not an installed managed plugin.', { name: parsed.name }) }
  }
  return { error: t('Unknown plugin: {arg}.', { arg: target }) }
}

async function removeAction(target: string | undefined, deps: PluginsDeps, prefix: string): Promise<number> {
  const r = resolveTarget(target, deps, 'remove')
  if (r === 'missing-arg') {
    deps.err(t('remove requires a plugin name: bccli plugins remove <name>'))
    return 1
  }
  if ('error' in r) {
    deps.err(r.error)
    return 1
  }
  const res = await deps.runNpm(prefix, ['uninstall', r.name])
  if (res.code !== 0) return npmFailure(res, deps)
  let next: string[]
  try {
    // Tahap SESUDAH npm: baca gagal → file sudah hilang, entry tidak berubah.
    next = deps.readPlugins().filter((e) => e !== r.entry)
  } catch (error) {
    deps.err(
      t('npm removed the files of {name} but the plugin config could not be read: {reason} — the entry list is unchanged; fix {path}, then run "bccli plugins remove {name}" again (safe to repeat).', {
        name: r.name,
        reason: (error as Error).message,
        path: globalConfigPath(deps.env),
      }),
    )
    return 1
  }
  try {
    deps.savePlugins(next)
  } catch (error) {
    // Aturan 4 transisi 3: file hilang, entry tertinggal → loader gagal start.
    deps.err(
      t('npm removed the files of {name} but the config entry {entry} remains: {reason}. bccli will refuse to start while that entry is listed — fix the config error at {path}, then run "bccli plugins remove {name}" again (safe to repeat), or delete the entry manually.', {
        name: r.name,
        entry: r.entry,
        reason: (error as Error).message,
        path: globalConfigPath(deps.env),
      }),
    )
    return 1
  }
  deps.out(t('{name} removed.', { name: r.name }))
  return 0
}

async function updateAction(target: string | undefined, deps: PluginsDeps, prefix: string): Promise<number> {
  // Aturan 5: sumber iterasi = entries di config, bukan scan direktori; config tidak ditulis.
  // Tahap baca update = SEBELUM npm (tidak pernah menulis).
  let names: string[]
  let hadMalformed = false
  if (target === undefined) {
    let entries: string[]
    try {
      entries = deps.readPlugins()
    } catch (error) {
      return readFailure('update', error as Error, deps)
    }
    names = []
    for (const entry of entries) {
      if (!isManagedEntry(entry)) continue
      const name = managedEntryName(entry)
      if (name) names.push(name)
      else {
        // Revisi #2/#7: malformed dilewati + peringatan, tidak pernah masuk argv npm.
        hadMalformed = true
        deps.err(t('Skipping malformed entry: {entry} — fix it manually in {path}.', { entry, path: globalConfigPath(deps.env) }))
      }
    }
    if (!names.length) {
      if (!hadMalformed) deps.out(t('No managed plugins to update.'))
      return hadMalformed ? 1 : 0
    }
  } else {
    const r = resolveTarget(target, deps, 'update')
    if (r === 'missing-arg') {
      deps.err(t('update requires a plugin name or no argument: bccli plugins update [name]'))
      return 1
    }
    if ('error' in r) {
      deps.err(r.error)
      return 1
    }
    names = [r.name]
  }
  ensurePrefixDir(prefix)
  let failed = false
  for (const name of names) {
    const argv = ['install', `${name}@latest`]
    const res = await deps.runNpm(prefix, argv)
    if (res.code !== 0) {
      failed = true
      deps.err(t('npm install failed ({code}): {stderr}', { code: String(res.code), stderr: res.stderr.slice(-400) }))
    } else {
      deps.out(t('{name} updated to latest.', { name }))
    }
  }
  // Exit 1 bila ada npm gagal ATAU ada entry malformed yang dilewati (config perlu dibereskan).
  return failed || hadMalformed ? 1 : 0
}
```

(Catatan implementasi: `npmFailure` = SATU sumber pesan, `deps.err` saja, tanpa `deps.out` ekstra. **Matriks pesan kegagalan §8 spec — 6 key berbeda, jangan disatukan**: (a) read SEBELUM npm → `readFailure(action)` untuk list/remove-via-resolveTarget/update (`no changes were made`); (b) read SESUDAH npm install → inline `npm finished but the config could not be read…`; (c) read SESUDAH npm remove → inline `npm removed the files of {name} but the plugin config could not be read…`; (d-f) write SESUDAH npm → 3 pesan transisi (install-baru/reinstall/remove). Bungkus setiap `deps.readPlugins()` di stage-nya masing-masing — JANGAN mencampur catch baca dengan catch tulis dalam satu blok (lihat removeAction: dua try terpisah). `parseCliArgs` mem-parse argumen `remove/update` yang diawali `-` sebagai opsi tak-dikenal (error) — perlindungan lapis-1; regex `managedEntryName`/`parseNpmSpec` = lapis-2.)

- [ ] **Step 4: GREEN** — `npx vitest run test/pluginsCli.test.ts` (kemudian bersihkan duplikasi pesan; semua test tetap hijau).
- [ ] **Step 5: Integrasi config-nyata (Aturan 2+4 end-to-end)** — tambah 1 test yang memakai `readGlobalPlugins` + `updateGlobalConfig` ASLI (env tmp) + `runNpm` palsu: install 2× → file `config.json` berisi tepat 1 entry DAN kunci lain (pre-seed `{model:'x'}`) utuh:

```ts
import { readGlobalPlugins, updateGlobalConfig } from '../src/config'
// deps: readPlugins: () => readGlobalPlugins(e), savePlugins: (x) => updateGlobalConfig(e, (cfg) => { cfg.plugins = x })
// pre-seed: writeFileSync(globalConfigPath(e), JSON.stringify({ model: 'x' }))
// install 'foo' ×2 → readGlobalPlugins(e) === ['​./plugins/node_modules/foo'] && raw.model === 'x'
```

- [ ] **Step 6: Gate** — tsc + lint (belum commit).

---

### Task 4: wiring — `args.ts` + `cli.ts` + `i18n/id.ts`

**Files:**
- Modify: `src/args.ts` (union + `SUBCOMMANDS` + daftar `subArgs` + baris HELP), `src/cli.ts` (dispatch pola `mcp`), `src/i18n/id.ts` (HELP key byte-identik + nilai ID + semua key pesan Task 3)
- Test: `test/args.test.ts` (tambah), i18n test (otomatis), `test/pluginsCli.test.ts` hijau

**Interfaces:**
- Consumes: `runPluginsCommand` + `PluginsDeps` (Task 3), `readGlobalPlugins`/`updateGlobalConfig` (Task 1), pola spawn npm `src/update.ts` (baca baris ~109 saat implementasi: `npm.cmd` win32 — tiru persis termasuk opsi shell-nya).
- Produces: `bccli plugins [list|install <spec>|remove <name>|update [name]]` berjalan di CLI.

- [ ] **Step 1: Test args RED** (tambah di `test/args.test.ts`):

```ts
test('plugins: subcommand + subArgs', () => {
  expect(parseCliArgs(['plugins', 'install', 'foo@latest'])).toMatchObject({
    command: 'plugins',
    subArgs: ['install', 'foo@latest'],
  })
  expect(parseCliArgs(['plugins']).subArgs).toEqual([])
})
```

(Catatan bahasa — revisi #3: test args ini assertion struktural murni; test serve di file
sama memakai regex lintas-bahasa `/--port/` dan `/loopback/` yang cocok baik di katalog
EN maupun ID → TIDAK perlu pin `setLanguage`. Pin EN hanya di `test/pluginsCli.test.ts`
(konteks: Global Constraints.)

- [ ] **Step 2: Implementasi args** — union `command` + `'plugins'`; `SUBCOMMANDS` += `'plugins'`; daftar `subArgs` += `'plugins'`; baris HELP (kolom 32):

```
  bccli plugins               list, install, remove, or update plugins
```

- [ ] **Step 3: i18n** — baris EN identik di key HELP `id.ts` + baris ID:
`  bccli plugins               daftar, install, remove, atau perbarui plugin` — plus semua key pesan Task 3 (`Invalid npm package spec…`, `{name} is already enabled.`, `{name} installed and enabled.`, `npm install failed ({code}): {stderr}`, **write-failure 3 transisi**: install-baru `…installed but NOT enabled…`, reinstall `…stays enabled through its existing entry…`, remove `…entry {entry} remains…refuse to start…`, **read-failure 3 tahap**: sebelum-npm `Cannot read the plugin config while running {action}…no changes were made…`, sesudah-npm install `npm finished but the config could not be read…entry list is unchanged…`, sesudah-npm remove `npm removed the files of {name} but the plugin config could not be read…`, **entry**: `Malformed managed entry…`, `Skipping malformed entry…`, `{name} removed.`, manual-entry tolak, `not an installed managed plugin`, `Unknown plugin: {arg}.`, `No managed plugins to update.`, `{name} updated to latest.`, 3× usage `install requires…`/`remove requires…`/`update requires…`, `Unknown action…`). Terjemahkan nilai ID per konteks CLI bccli (lihat gaya `mcp` di `id.ts`).
- [ ] **Step 4: Dispatch `cli.ts`** (pola `mcp`, sebelum `createRuntime`):

```ts
if (args.command === 'plugins') {
  const { runPluginsCommand } = await import('./pluginsCli')
  const { globalConfigPath: gcp, readGlobalPlugins, updateGlobalConfig } = await import('./config')
  const runNpm = async (prefix: string, argv: string[]) => {
    const { spawn } = await import('node:child_process')
    const cmd = process.platform === 'win32' ? 'npm.cmd' : 'npm' // pola src/update.ts
    return await new Promise<{ code: number; stderr: string }>((resolve) => {
      const child = spawn(cmd, ['--prefix', prefix, ...argv], { stdio: ['ignore', 'ignore', 'pipe'] })
      let stderr = ''
      child.stderr?.on('data', (c: Buffer) => (stderr += c))
      child.on('error', (error) => resolve({ code: 1, stderr: error.message }))
      child.on('close', (code) => resolve({ code: code ?? 1, stderr }))
    })
  }
  return runPluginsCommand(args, {
    out: (s) => console.log(s),
    err: (s) => console.error(s),
    env: process.env,
    runNpm,
    readPlugins: () => readGlobalPlugins(process.env),
    savePlugins: (entries) => updateGlobalConfig(process.env, (cfg) => { cfg.plugins = entries }),
  })
}
```

(Catatan: saat implementasi, baca dulu spawn di `src/update.ts` — jika memakai `shell: true`, pertahankan pola yang sama; argumen sudah dijamin bebas metachar oleh regex Task 2. Hapus import tak terpakai `gcp`.)

- [ ] **Step 5: Jalankan** `npx vitest run test/args.test.ts test/i18n.test.ts test/pluginsCli.test.ts` → GREEN.
- [ ] **Step 6: Gate** — tsc + lint (belum commit).

---

### Task 5: gates penuh 2×, canary (DITAHAN), AGENTS.md, laporan

- [ ] **Step 1: Gates penuh 2×** — `npx tsc --noEmit -p tsconfig.json`; `npm run lint`; `npm test` (2×, catat jumlah); `npm run build`.
- [ ] **Step 2: Canary npm nyata — DITAHAN (izin user eksplisit dulu).** Bila diizinkan: sandbox `BCCLI_HOME` + `bccli plugins install <paket kecil nyata>` → verifikasi node_modules terpasang, entry masuk config, `list` ✓ versi, `remove` bersih. Bila tidak — lewati, catat di laporan.
- [ ] **Step 3: AGENTS.md** — bullet sub-proyek #2 (fitur, aturan, gates, deviasi, canary status) via tool edit.
- [ ] **Step 4: Laporan** — tabel fitur per task + hasil gates + status canary + daftar commit + pengingat: marketplace npm nyata (browse/registry) tetap non-goal v1; lanjut sub-proyek #3 (OAuth) atau rilis.

---

## Self-Review (penulis)

1. **Spec coverage**: §2 perintah→Task 3; §3 Aturan 1→Task 2 (+install guard Task 3); §4 direktori/entry→Task 2–3 (`ensurePrefixDir`, **`bccliHome(deps.env)` untuk semua path**, `managedEntryName` validasi entry); §5 Aturan 2→Task 3 test idempoten (tulis kedua = isi identik); §6 Aturan 3→Task 3 `resolveTarget` (malformed ditolak tanpa npm) + `list` resolusi sejajar loader; §7 Aturan 5→Task 3 `updateAction` (files-only + skip malformed); §8 Aturan 4→Task 1 atomik + Task 3 **tes 5a/5b/5c (write) + matriks read 5 sel (tes revisi #4)**; §9 CLI/i18n→Task 4; §10 test matrix→Task 1–4 (**tes 9–13 = revisi user #1–#4**); §11 deviasi→implementasi.
2. **Placeholder scan**: tidak ada TBD; dua catatan pembersihan duplikasi pesan ditandai eksplisit (npmFailure tunggal, resolveTarget cabang ganda) — instruksi aksi, bukan "isi nanti".
3. **Konsistensi tipe**: `ParsedSpec.name/spec` konsisten Task 2↔3; `PluginsDeps` identik deklarasi/test/dispatch; prefix konstan `./plugins/node_modules/` hanya dari `managedEntry`/`isManagedEntry`/`managedEntryName`; `runNpm(prefix, argv)` urutan sama di test & cli; exit code 0/1 konsisten; **SEMUA path home via `bccliHome(deps.env)`** (0 sisa `BCCLI_HOME ?? ''` — verifikasi `rg`); nama masuk argv npm SELALU hasil `parseNpmSpec`/`managedEntryName` yang tervalidasi; semua pesan memakai `globalConfigPath(deps.env)`; **6 blok pesan kegagalan = 3 write (transisi) + 3 read (tahap/operasi)** dipastikan terbedakan oleh assert `not.toContain` silang di tes 5a/5b/5c + matriks read (revisi #4).
4. **Ketentuan user**: 5 aturan awal masing-masing punya test bernomor aturan; **4 revisi kedua** (bccliHome, validasi entry, resolusi list, matriks read) masing-masing punya test bernomor revisi (§10 item 9–13; kode Task 2/3 diberi komentar `Revisi #n`); "tanpa commit/npm/impl sebelum review" dicatat di Global Constraints.
