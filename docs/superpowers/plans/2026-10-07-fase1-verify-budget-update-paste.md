# Fase 1 Gap Closure (verify · budget · update · paste-image) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tutup 4 gap "menengah" bccli vs aplikasi matang: auto lint/test pasca-edit (`verifyCommands`), cost cap (`usageCap`), auto-update check + `bccli update`, dan paste gambar dari clipboard (keybind `pasteImage`).

**Architecture:** Semua fitur = modul murni baru (`src/verify.ts`, `src/budget.ts`, `src/update.ts`, `src/clipboardImage.ts`) + wiring tipis di `config.ts`/`agent.ts`/`App.tsx`/`print.ts`/`cli.ts`. Config global-only (project config tidak boleh memicu eksekusi/biaya). TDD RED→GREEN per task.

**Tech Stack:** TypeScript ESM, ink 7, vitest, biome. Shell commands via `runCommand` (tools/bash) atau `execFile`.

**Spec:** gap analysis 2026-10-07 (item #4 auto lint/test, #12 cost cap, #13 auto-update, #6 paste gambar). Quick wins beta.39 (keybinds, /redo, plugin CJS, models <provider>, /pr guard) SUDAH terimplementasi di working tree — Task 0 meng-commit-nya.

## Global Constraints

- TDD: tulis test gagal dulu, verifikasi RED, baru implementasi.
- i18n: setiap string `t('...')` baru WAJIB ada di `src/i18n/id.ts`; tidak boleh ada key stale (key yang tidak dipakai src); placeholder `{x}` identik di key & terjemahan. Suite berjalan dalam bahasa Indonesia — assertion test jangan bergantung teks EN.
- Fitur config baru HANYA dibaca dari global config (`~/.bccli/config.json` / `BCCLI_HOME`), tidak dari project config (pola hooks/plugins/networkPolicy/keybinds).
- Gates tiap task: `npx vitest run <file>`; akhir: `npm test`, `npm run typecheck`, `npm run lint`, `npm run build` semua hijau.
- Commit lokal per task (conventional commits). JANGAN push, JANGAN bump version, JANGAN publish — rilis ditahan atas permintaan user.
- Jangan ubah perilaku yang tidak terkait.

---

### Task 0: Commit pekerjaan beta.39 yang sudah hijau

**Files:**
- Tidak ada perubahan file; hanya git.

**Interfaces:**
- Consumes: working tree saat ini (19 file: keybinds, /redo, plugin CJS, models <provider>, /pr guard) — gates sudah hijau (524 passed/1 skipped, tsc 0, lint 0, build OK).
- Produces: commit lokal `feat: keybind config, /redo, cjs plugins, models <provider>, read-only /pr guard` sebagai dasar task berikut.

- [ ] **Step 1: Verifikasi status**

Run: `git status --short; npm run typecheck`
Expected: 12 modified + 7 untracked; typecheck tanpa output.

- [ ] **Step 2: Commit**

```bash
git add -A
git commit -m "feat: keybind config, /redo, cjs plugins, models <provider>, read-only /pr guard"
```

---

### Task 1: `verifyCommands` — auto lint/test pasca-edit

Model: aider `--test-cmd`. Setelah giliran yang mengedit file, jalankan perintah verifikasi; bila gagal, kirim follow-up ke model (maks 2 ronde) agar diperbaiki.

**Files:**
- Create: `src/verify.ts`
- Modify: `src/config.ts` (interface Config, DEFAULT_CONFIG, resolvedVerifyCommands, loadConfig)
- Modify: `src/ui/App.tsx` (runTurn, onEvent tracking edit)
- Modify: `src/print.ts` (loop verify pasca-run di print mode)
- Modify: `src/i18n/id.ts`
- Test: `test/verify.test.ts` (baru), `test/ui/app.test.tsx` atau `test/ui/verify.test.tsx` (baru)

**Interfaces:**
- Consumes: `runCommand(command, { cwd, timeoutMs, signal, env }): Promise<CommandResult>` dari `src/tools/bash.ts` (`CommandResult` punya `exitCode: number`, `output: string`); `ConfigError` dari config; `t` dari i18n; AgentEvent `toolEnd` punya field `tool`, `isError`.
- Produces (dipakai App.tsx/print.ts):
  - `MAX_VERIFY_ROUNDS = 2`
  - `runVerify(commands: string[], opts: { cwd: string; env: NodeJS.ProcessEnv; signal: AbortSignal; timeoutMs?: number; run?: typeof runCommand }): Promise<VerifyFailure[]>`
  - `interface VerifyFailure { cmd: string; exitCode: number; output: string }`
  - `verifyFollowup(failures: VerifyFailure[], maxBytes?: number): string`
  - `Config.verifyCommands: string[]` (selalu array, default `[]`)

- [ ] **Step 1: Tulis test gagal `test/verify.test.ts`**

```ts
import { expect, test } from 'vitest'
import { MAX_VERIFY_ROUNDS, runVerify, verifyFollowup, type VerifyFailure } from '../src/verify'

const signal = new AbortController().signal

test('runVerify returns failures with exit code and output, in order', async () => {
  const calls: string[] = []
  const fakeRun = (async (cmd: string) => {
    calls.push(cmd)
    return cmd.includes('bad')
      ? { exitCode: 3, output: 'boom', timedOut: false, aborted: false }
      : { exitCode: 0, output: 'ok', timedOut: false, aborted: false }
  }) as never
  const failures = await runVerify(['good-cmd', 'bad-cmd', 'bad2'], { cwd: '.', env: {}, signal, run: fakeRun })
  expect(calls).toEqual(['good-cmd', 'bad-cmd', 'bad2']) // semua jalan, tidak short-circuit
  expect(failures).toEqual([
    { cmd: 'bad-cmd', exitCode: 3, output: 'boom' },
    { cmd: 'bad2', exitCode: 3, output: 'boom' },
  ])
  expect(MAX_VERIFY_ROUNDS).toBe(2)
})

test('verifyFollowup contains every failed command and truncates long output', () => {
  const long = 'x'.repeat(20000)
  const failures: VerifyFailure[] = [
    { cmd: 'npm run lint', exitCode: 1, output: long },
    { cmd: 'npm test', exitCode: 2, output: 'short' },
  ]
  const text = verifyFollowup(failures, 100)
  expect(text).toContain('npm run lint')
  expect(text).toContain('[exit code 1]')
  expect(text).toContain('npm test')
  expect(text.length).toBeLessThan(1000)
  expect(text).toContain('[truncated]')
})
```

- [ ] **Step 2: RED** — `npx vitest run test/verify.test.ts` → gagal "Cannot find module '../src/verify'".

- [ ] **Step 3: Implementasi `src/verify.ts`**

```ts
import { t } from './i18n'
import { runCommand } from './tools/bash'

export interface VerifyFailure {
  cmd: string
  exitCode: number
  output: string
}

/** Fix rounds per user turn; keeps a failing verify command from looping forever. */
export const MAX_VERIFY_ROUNDS = 2

export async function runVerify(
  commands: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; signal: AbortSignal; timeoutMs?: number; run?: typeof runCommand },
): Promise<VerifyFailure[]> {
  const run = opts.run ?? runCommand
  const failures: VerifyFailure[] = []
  for (const cmd of commands) {
    const r = await run(cmd, { cwd: opts.cwd, timeoutMs: opts.timeoutMs ?? 300_000, signal: opts.signal, env: opts.env })
    if (r.exitCode !== 0) failures.push({ cmd, exitCode: r.exitCode, output: r.output })
  }
  return failures
}

export function verifyFollowup(failures: VerifyFailure[], maxBytes = 8000): string {
  const blocks = failures.map((f) => {
    const output = f.output.length > maxBytes ? `${f.output.slice(0, maxBytes)}\n[truncated]` : f.output
    return `$ ${f.cmd}\n[exit code ${f.exitCode}]\n${output}`
  })
  return t('Automatic verification after your edits failed. Fix the problems so these commands pass, then stop.\n\n{blocks}', {
    blocks: blocks.join('\n\n'),
  })
}
```

- [ ] **Step 4: GREEN** — `npx vitest run test/verify.test.ts` → pass.

- [ ] **Step 5: Config — test dulu (tambahkan ke `test/keybinds.test.ts`? TIDAK; buat di `test/config.test.ts` bila ada bagian serupa, else test/verify.test.ts):**

```ts
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConfigError, loadConfig } from '../src/config'

const load = (global: object) => {
  const h = mkdtempSync(join(tmpdir(), 'bccli-v-'))
  writeFileSync(join(h, 'config.json'), JSON.stringify(global))
  return loadConfig(mkdtempSync(join(tmpdir(), 'bccli-vc-')), { BCCLI_HOME: h })
}

test('verifyCommands defaults to empty and rejects junk', () => {
  expect(load({}).verifyCommands).toEqual([])
  expect(load({ verifyCommands: ['npm run lint'] }).verifyCommands).toEqual(['npm run lint'])
  expect(() => load({ verifyCommands: 'npm run lint' })).toThrow(ConfigError)
  expect(() => load({ verifyCommands: [''] })).toThrow(ConfigError)
})
```

RED → implementasi di `src/config.ts`:
- Interface `Config`: tambah `/** Commands run after a turn that edited files (aider --test-cmd style). Global config only. */ verifyCommands: string[]`.
- `DEFAULT_CONFIG`: `verifyCommands: []`.
- Helper:

```ts
function resolvedVerifyCommands(global: Partial<Config>): string[] {
  const value = global.verifyCommands
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some((c) => typeof c !== 'string' || !c.trim())) {
    throw new ConfigError(t('verifyCommands must be an array of non-empty strings.'))
  }
  return (value as string[]).map((c) => c.trim())
}
```

- `loadConfig` return: `verifyCommands: resolvedVerifyCommands(global),`.
- id.ts: `'verifyCommands must be an array of non-empty strings.': 'verifyCommands harus berupa array of string tidak kosong.'`

- [ ] **Step 6: App wiring — test UI dulu `test/ui/verify.test.tsx`** (pola `test/ui/redo.test.tsx`: scripted provider, ink-testing-library, temp BCCLI_HOME):

```tsx
// provider: step1 = write tool call; step2 (follow-up verify) = text 'FIXED'
// config home: { "verifyCommands": ["node -e \"process.exit(3)\""] }
// kirim prompt + \r; waitFor frame mengandung 'FIXED'
// assert: frames berisi notice verifikasi (cek kata dari id.ts, mis. 'Verifikasi') DAN file a.txt tertulis
// assert provider steps habis (follow-up terkirim)
```

Implementasi di `src/ui/App.tsx`:
- Import `{ MAX_VERIFY_ROUNDS, runVerify, verifyFollowup }` dari `'../verify'`.
- Ref baru: `const editedInTurn = useRef(false)`; di `onEvent`: `if (event.type === 'toolEnd' && (event.tool === 'edit' || event.tool === 'write') && !event.isError) editedInTurn.current = true`.
- `runTurn`: set `editedInTurn.current = false` di awal; JANGAN null-kan `controller.current` sebelum verify selesai; setelah `await runtime.agent.run(...)` sisipkan:

```tsx
      const signal = controller.current.signal
      const commands = runtime.config.verifyCommands
      if (editedInTurn.current && commands.length) {
        for (let round = 0; round < MAX_VERIFY_ROUNDS; round++) {
          notice(t('Verifying edits: {cmds}', { cmds: commands.join(', ') }))
          const failures = await runVerify(commands, { cwd: runtime.cwd, env: runtime.env, signal })
          if (!failures.length) {
            notice(t('Verification passed.'))
            break
          }
          if (round === MAX_VERIFY_ROUNDS - 1 || signal.aborted) {
            notice(t('Verification still failing after {n} fix round(s). Run the commands manually to see why.', { n: MAX_VERIFY_ROUNDS }), 'warn')
            break
          }
          await runtime.agent.run(verifyFollowup(failures), signal)
        }
      }
      controller.current = null
```

- id.ts keys baru (nilai ID): `'Verifying edits: {cmds}'`, `'Verification passed.'`, `'Verification still failing after {n} fix round(s). Run the commands manually to see why.'`, dan key follow-up multi-baris `'Automatic verification after your edits failed. Fix the problems so these commands pass, then stop.\n\n{blocks}'`.

- [ ] **Step 7: print mode wiring** — di `src/print.ts` `runPrint`, setelah agent.run selesai (sebelum format output), loop verify yang sama (tanpa notice UI; tulis progres ke `io.err`): failures → `io.err.write(t('Verification failed: {cmds}', { cmds }))` → follow-up `rt.agent.run(verifyFollowup(...), signal)` maks `MAX_VERIFY_ROUNDS`. Test: tambahkan kasus di test print yang sudah ada (cari `test/print*.test.ts`) dengan scripted provider 2 step + verifyCommands gagal via runtime config.

- [ ] **Step 8: Gates + commit**

```bash
npx vitest run test/verify.test.ts test/ui/verify.test.tsx test/config.test.ts && npm run typecheck && npm run lint
git add -A && git commit -m "feat: verifyCommands - auto-run lint/test after edits with model fix rounds"
```

---

### Task 2: `usageCap` — cost/token cap per sesi

**Files:**
- Create: `src/budget.ts`
- Modify: `src/config.ts`, `src/agent.ts` (event union + check di loop), `src/print.ts` (case budgetExceeded), `src/ui/App.tsx` (notice), `src/setup.ts` (teruskan cap+model ke Agent), `src/i18n/id.ts`
- Test: `test/budget.test.ts` (baru), `test/agent.test.ts` (tambah kasus)

**Interfaces:**
- Consumes: `Agent.totalUsage: { inputTokens, outputTokens, ... }`; pola event `stepLimit` di agent.ts (emit setelah loop) & print.ts:52.
- Produces:
  - `interface UsageCap { tokens?: number; usd?: number; prices?: Record<string, { input: number; output: number }> }` (harga per 1 juta token)
  - `priceFor(cap: UsageCap, model: string): { input: number; output: number } | undefined` (key pertama yang merupakan substring dari model ref)
  - `budgetStatus(usage: { inputTokens: number; outputTokens: number }, cap: UsageCap | undefined, model: string): { kind: 'tokens' | 'usd'; used: number; limit: number } | undefined`
  - `Config.usageCap?: UsageCap`; AgentEvent `{ type: 'budgetExceeded'; kind: 'tokens' | 'usd'; used: number; limit: number }`

- [ ] **Step 1: Test gagal `test/budget.test.ts`**

```ts
import { expect, test } from 'vitest'
import { budgetStatus, priceFor } from '../src/budget'

test('token cap blocks at or above the limit', () => {
  const cap = { tokens: 100 }
  expect(budgetStatus({ inputTokens: 40, outputTokens: 50 }, cap, 'x/y')).toBeUndefined()
  expect(budgetStatus({ inputTokens: 40, outputTokens: 60 }, cap, 'x/y')).toEqual({ kind: 'tokens', used: 100, limit: 100 })
})

test('usd cap uses the first price entry whose key is contained in the model ref', () => {
  const cap = { usd: 1, prices: { 'glm-5.3': { input: 2, output: 8 }, glm: { input: 100, output: 100 } } }
  expect(priceFor(cap, 'bc-cloud/glm-5.3-flash')).toEqual({ input: 2, output: 8 })
  // 400k in * 2 + 100k out * 8 = 0.8 + 0.8 = 1.6 usd >= 1
  expect(budgetStatus({ inputTokens: 400_000, outputTokens: 100_000 }, cap, 'bc-cloud/glm-5.3-flash')).toEqual({ kind: 'usd', used: 1.6, limit: 1 })
  expect(budgetStatus({ inputTokens: 10, outputTokens: 10 }, cap, 'bc-cloud/glm-5.3-flash')).toBeUndefined()
})

test('usd cap without a matching price never blocks', () => {
  const cap = { usd: 0.001, prices: { nomatch: { input: 9, output: 9 } } }
  expect(budgetStatus({ inputTokens: 1e9, outputTokens: 1e9 }, cap, 'bc-cloud/glm-5.3-flash')).toBeUndefined()
  expect(budgetStatus({ inputTokens: 1, outputTokens: 1 }, undefined, 'x')).toBeUndefined()
})
```

- [ ] **Step 2: RED** → implementasi `src/budget.ts` persis sesuai signature di atas (pure, tanpa import selain tipe).

- [ ] **Step 3: Config** — test: `load({ usageCap: { tokens: 0 } })` throw ConfigError; `load({ usageCap: { usd: 1 } })` (tanpa prices) throw ConfigError; `load({ usageCap: { tokens: 1000 } }).usageCap` = `{ tokens: 1000 }`; junk (string) throw. Implementasi `resolvedUsageCap(global)` di config.ts: validasi angka finite > 0 untuk tokens/usd; prices record dengan input/output angka finite >= 0; `usd` tanpa `prices` → `ConfigError(t('usageCap.usd requires usageCap.prices (USD per 1M tokens).'))`. `Config.usageCap?: UsageCap`, loadConfig meneruskan. id.ts key baru.

- [ ] **Step 4: Agent** — test di `test/agent.test.ts` (ikuti pola test agent yang ada): fake provider yang mengembalikan `usage: { inputTokens: 90, outputTokens: 90 }`; agent opts `usageCap: { tokens: 100 }`; panggil `run()` dua kali → panggilan kedua TIDAK menembak provider lagi dan events memuat `{ type: 'budgetExceeded', kind: 'tokens', ... }`. Implementasi:
  - `src/agent.ts`: event union tambah `| { type: 'budgetExceeded'; kind: 'tokens' | 'usd'; used: number; limit: number }`; `AgentOptions` tambah `usageCap?: UsageCap; budgetModel?: string`; simpan di field private.
  - Di awal setiap step loop (sebelum pemanggilan provider, dekat `for (let step = 0; ...)` baris ~194): 

```ts
        const over = budgetStatus(this.totalUsage, this.usageCap, this.budgetModel ?? '')
        if (over) {
          this.onEvent({ type: 'budgetExceeded', ...over })
          return
        }
```

  - `src/setup.ts` createRuntime: teruskan `usageCap: config.usageCap, budgetModel: <modelRef resolved>` ke构造 Agent (ikuti cara opts lain diteruskan).

- [ ] **Step 5: UI/print** — print.ts: case `'budgetExceeded'` → `io.err.write(t('Budget exceeded ({kind}): {used} of {limit}. Further model calls are blocked; raise usageCap in ~/.bccli/config.json.') + '\n')`; `failed = true` (pola stepLimit). App.tsx onEvent: `if (event.type === 'budgetExceeded') notice(t(...sama...), 'warn')`. Cek `applyEvent` di transcript.ts punya fallback aman untuk event tak dikenal; bila switch exhaustive, tambah case no-op. id.ts: terjemahan key budget.

- [ ] **Step 6: Gates + commit**

```bash
npx vitest run test/budget.test.ts test/agent.test.ts test/config.test.ts && npm run typecheck && npm run lint
git add -A && git commit -m "feat: usageCap - per-session token/usd budget that blocks further model calls"
```

---

### Task 3: Auto-update check + `bccli update`

**Files:**
- Create: `src/update.ts`
- Modify: `src/args.ts` (SUBCOMMANDS + HELP), `src/cli.ts` (dispatch `update`; notice saat TUI interaktif), `src/config.ts` (`updateCheck?: 'on' | 'off'`), `src/i18n/id.ts` (termasuk blok HELP EN+ID)
- Test: `test/update.test.ts` (baru)

**Interfaces:**
- Consumes: `VERSION` dari `src/version.ts`; `bccliHome(env)` dari config.
- Produces:
  - `compareVersions(a: string, b: string): number` (semver sederhana + prerelease: `0.4.0-beta.38 < 0.4.0-beta.39 < 0.4.0`)
  - `channelFor(version: string): 'next' | 'latest'` (ada tanda `-` → next)
  - `dueForCheck(cache: { checkedAt: string } | undefined, now: Date, intervalMs?: number): boolean` (default 24 jam)
  - `updateNotice(current: string, latest: string | undefined): string | undefined`
  - `checkForUpdate(deps: { home: string; fetch: typeof fetch; now: Date; timeoutMs?: number }): Promise<string | undefined>` — fetch `https://registry.npmjs.org/-/package/@botconnector/bccli/dist-tags`, baca channel dari `channelFor(VERSION)`, tulis cache `update-check.json` `{ checkedAt, latest }` (atomic), return notice bila lebih baru; tidak pernah melempar.
  - `runUpdateCommand(deps: { env: NodeJS.ProcessEnv; spawn?: typeof import('node:child_process').spawnSync }): Promise<number>`

- [ ] **Step 1: Test gagal `test/update.test.ts`**

```ts
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { channelFor, checkForUpdate, compareVersions, dueForCheck, runUpdateCommand, updateNotice } from '../src/update'

test('compareVersions orders prereleases below releases', () => {
  expect(compareVersions('0.4.0-beta.38', '0.4.0-beta.39')).toBeLessThan(0)
  expect(compareVersions('0.4.0-beta.39', '0.4.0')).toBeLessThan(0)
  expect(compareVersions('0.4.0', '0.4.0')).toBe(0)
  expect(compareVersions('0.10.0', '0.9.9')).toBeGreaterThan(0)
  expect(compareVersions('1.0.0', '0.99.99')).toBeGreaterThan(0)
})

test('channelFor: prerelease tracks next', () => {
  expect(channelFor('0.4.0-beta.38')).toBe('next')
  expect(channelFor('0.4.0')).toBe('latest')
})

test('dueForCheck respects the 24h interval and missing cache', () => {
  const now = new Date('2026-10-07T12:00:00Z')
  expect(dueForCheck(undefined, now)).toBe(true)
  expect(dueForCheck({ checkedAt: '2026-10-07T00:00:00Z' }, now)).toBe(true)
  expect(dueForCheck({ checkedAt: '2026-10-07T06:00:00Z' }, now)).toBe(false)
})

test('checkForUpdate writes the cache and returns a notice only when newer', async () => {
  const home = mkdtempSync(join(tmpdir(), 'bccli-upd-'))
  const fetchOk = (async () => new Response(JSON.stringify({ latest: '9.9.9', next: '9.9.9-beta.1' }))) as typeof fetch
  const notice = await checkForUpdate({ home, fetch: fetchOk, now: new Date() })
  expect(notice).toContain('9.9.9')
  const cache = JSON.parse(readFileSync(join(home, 'update-check.json'), 'utf8'))
  expect(cache.latest).toBe('9.9.9')
  expect(existsSync(join(home, 'update-check.json'))).toBe(true)
})

test('checkForUpdate never throws on a dead registry', async () => {
  const home = mkdtempSync(join(tmpdir(), 'bccli-upd2-'))
  const fetchBad = (async () => { throw new Error('ECONNREFUSED') }) as typeof fetch
  expect(await checkForUpdate({ home, fetch: fetchBad, now: new Date() })).toBeUndefined()
})

test('updateNotice is undefined when not newer', () => {
  expect(updateNotice('9.9.9', '9.9.9')).toBeUndefined()
  expect(updateNotice('9.9.9', undefined)).toBeUndefined()
})

test('runUpdateCommand installs from npm on the right channel', async () => {
  const calls: unknown[][] = []
  const fakeSpawn = ((cmd: string, args: string[]) => { calls.push([cmd, args]); return { status: 0 } }) as never
  expect(await runUpdateCommand({ env: { BCCLI_VERSION_OVERRIDE: '0.4.0-beta.38' }, spawn: fakeSpawn })).toBe(0)
  expect(calls[0]![1]).toContain('@botconnector/bccli@next')
})
```

Catatan: `runUpdateCommand` memakai `VERSION` kecuali `env.BCCLI_VERSION_OVERRIDE` di-set (hook testabilitas).

- [ ] **Step 2: RED** → implementasi `src/update.ts`:
  - `compareVersions`: split `core-prerelease`; core numerik per bagian; bila core sama: tanpa prerelease > dengan prerelease; prerelease dibanding per identifier (numerik vs leksikal).
  - `checkForUpdate`: `if (!dueForCheck(readCache(home), now)) return updateNotice(VERSION, readCache(home)?.latest)`; fetch dist-tags dengan `AbortSignal.timeout(timeoutMs ?? 3000)`; `latest = tags[channelFor(VERSION)] ?? tags.latest`; tulis cache atomic (tulis `.tmp` lalu rename); return `updateNotice(VERSION, latest)`. Semua dalam try/catch → undefined.
  - `updateNotice`: `latest && compareVersions(VERSION, latest) < 0 ? t('A new bccli is available: {latest} (you have {current}). Run: bccli update', { latest, current: VERSION }) : undefined`.
  - `runUpdateCommand`: `const version = deps.env.BCCLI_VERSION_OVERRIDE ?? VERSION; const spec = '@botconnector/bccli@' + channelFor(version); const spawn = deps.spawn ?? spawnSync; const isWin = process.platform === 'win32'; const r = spawn(isWin ? 'npm.cmd' : 'npm', ['i', '-g', spec], { stdio: 'inherit', env: deps.env }); return r.status ?? 1`.

- [ ] **Step 3: CLI wiring**
  - `src/args.ts`: `SUBCOMMANDS` tambah `'update'`; type command tambah `'update'`; HELP baris baru setelah models: `  bccli update                    install the newest bccli from npm` (jaga kolom deskripsi = 32) — update JUGA key blok HELP di id.ts (EN key & nilai ID: `  bccli update                    pasang bccli terbaru dari npm`).
  - `src/cli.ts`: dispatch sebelum `createRuntime`:

```ts
  if (args.command === 'update') {
    const { runUpdateCommand } = await import('./update')
    return runUpdateCommand({ env: process.env })
  }
```

  - Notice interaktif: di `main()`, hanya bila `args.command === 'run' && !args.print && process.stderr.isTTY`, sebelum render TUI:

```ts
  try {
    const { loadConfig } = await import('./config')
    if (loadConfig(cwd).updateCheck !== 'off') {
      const { checkForUpdate } = await import('./update')
      const notice = await checkForUpdate({ home: bccliHome(process.env), fetch: globalThis.fetch, now: new Date() })
      if (notice) console.error(notice)
    }
  } catch {
    // update checks are best effort and must never block startup
  }
```

  - `src/config.ts`: `updateCheck?: 'on' | 'off'` (global-only; `resolvedUpdateCheck` menolak nilai lain dengan ConfigError; loadConfig meneruskan `global.updateCheck`). id.ts key validasi.

- [ ] **Step 4: Gates + commit**

```bash
npx vitest run test/update.test.ts && npm run typecheck && npm run lint
git add -A && git commit -m "feat: daily update check with notice and bccli update command"
```

---

### Task 4: Paste gambar dari clipboard (keybind `pasteImage`, default `alt+v`)

Terminal tidak mengirim gambar via stdin; solusi Windows: `Get-Clipboard -Format Image` → simpan PNG temp → sisipkan path ke input prompt (model membacanya via tool `read` yang sudah mendukung vision). `ctrl+v` TIDAK dipakai (bentrok paste terminal).

**Files:**
- Create: `src/clipboardImage.ts`
- Modify: `src/keybinds.ts` (`KEYBIND_ACTIONS`, `DEFAULT_KEYBINDS` += pasteImage `alt+v`), `src/ui/App.tsx` (branch keybind + state inject), `src/ui/PromptInput.tsx` (prop `injected`), `src/i18n/id.ts`
- Test: `test/clipboardImage.test.ts` (baru), tambah kasus default di `test/keybinds.test.ts`, `test/ui/pasteImage.test.tsx` (baru, `vi.mock`)

**Interfaces:**
- Consumes: `matchKeybind`/`Keybind` dari keybinds; `insert` dari `src/ui/lineEdit.ts`; `t`.
- Produces:
  - `interface GrabDeps { platform: NodeJS.Platform; tmpdir: string; now: Date; run(cmd: string, args: string[]): Promise<{ code: number; output: string }> }`
  - `clipboardCommand(platform: NodeJS.Platform, target: string): { cmd: string; args: string[] } | undefined`
  - `grabClipboardImage(deps: GrabDeps): Promise<string | undefined>` (undefined = kosong/tidak didukung; default `run` = execFile)
  - `KeybindAction` += `'pasteImage'`; `DEFAULT_KEYBINDS.pasteImage = 'alt+v'`
  - `PromptInput` prop baru `injected?: { text: string; n: number }`

- [ ] **Step 1: Test gagal `test/clipboardImage.test.ts`**

```ts
import { expect, test } from 'vitest'
import { clipboardCommand, grabClipboardImage } from '../src/clipboardImage'

const now = new Date('2026-10-07T12:00:00Z')

test('windows uses powershell Get-Clipboard and saves PNG', () => {
  const c = clipboardCommand('win32', 'C:\\tmp\\x.png')!
  expect(c.cmd).toBe('powershell.exe')
  expect(c.args.join(' ')).toContain('Get-Clipboard -Format Image')
  expect(c.args.join(' ')).toContain('C:\\tmp\\x.png')
})

test('darwin uses osascript, linux uses xclip, others unsupported', () => {
  expect(clipboardCommand('darwin', '/tmp/x.png')!.cmd).toBe('osascript')
  expect(clipboardCommand('linux', '/tmp/x.png')!.args.join(' ')).toContain('xclip')
  expect(clipboardCommand('aix' as NodeJS.Platform, '/tmp/x.png')).toBeUndefined()
})

test('grab returns the path only when the command reports OK', async () => {
  const ok = grabClipboardImage({ platform: 'win32', tmpdir: 'test/fixtures', now, run: async () => ({ code: 0, output: 'OK' }) })
  // fixture: file bccli-clipboard-<stamp>.png dibuat dulu oleh fake run
  ...
})
```

(Implementasi test 'grab': fake `run` menulis file stamp yang diharapkan lalu return OK → expect path; variant `EMPTY` → undefined; variant platform tak didukung → undefined tanpa memanggil run.)

- [ ] **Step 2: RED** → implementasi `src/clipboardImage.ts`:

```ts
import { execFile } from 'node:child_process'
import { existsSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface GrabDeps {
  platform: NodeJS.Platform
  tmpdir: string
  now: Date
  run(cmd: string, args: string[]): Promise<{ code: number; output: string }>
}

export function clipboardTarget(tmpdir: string, now: Date): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
  return join(tmpdir, `bccli-clipboard-${stamp}.png`)
}

export function clipboardCommand(platform: NodeJS.Platform, target: string): { cmd: string; args: string[] } | undefined {
  if (platform === 'win32') {
    const escaped = target.replace(/'/g, "''")
    return {
      cmd: 'powershell.exe',
      args: [
        '-NoProfile', '-NonInteractive', '-Command',
        `Add-Type -AssemblyName System.Drawing; $img = Get-Clipboard -Format Image -ErrorAction SilentlyContinue; if ($img) { $img.Save('${escaped}', [System.Drawing.Imaging.ImageFormat]::Png); 'OK' } else { 'EMPTY' }`,
      ],
    }
  }
  if (platform === 'darwin') {
    return {
      cmd: 'osascript',
      args: ['-e', 'try', '-e', 'set d to the clipboard as «class PNGf»', '-e', `set f to open for access POSIX file "${target}" with write permission`, '-e', 'set eof f to 0', '-e', 'write d to f', '-e', 'close access f', '-e', '"OK"', '-e', 'on error', '-e', '"EMPTY"', '-e', 'end try'],
    }
  }
  if (platform === 'linux') {
    return { cmd: 'sh', args: ['-c', `xclip -selection clipboard -t image/png -o > '${target}' 2>/dev/null && echo OK || echo EMPTY`] }
  }
  return undefined
}

const defaultRun = (cmd: string, args: string[]) =>
  new Promise<{ code: number; output: string }>((resolve) => {
    execFile(cmd, args, { timeout: 15_000, windowsHide: true }, (error, stdout) =>
      resolve({ code: error ? (error as { code?: number }).code ?? 1 : 0, output: String(stdout ?? '') }),
    )
  })

export async function grabClipboardImage(deps: GrabDeps): Promise<string | undefined> {
  const target = clipboardTarget(deps.tmpdir, deps.now)
  const command = clipboardCommand(deps.platform, target)
  if (!command) return undefined
  const run = deps.run ?? defaultRun
  const r = await run(command.cmd, command.args)
  if (r.code === 0 && r.output.includes('OK') && existsSync(target) && statSync(target).size > 0) return target
  return undefined
}
```

(Hapus import `writeFileSync` bila tidak terpakai.)

- [ ] **Step 3: Keybind** — `src/keybinds.ts`: `KEYBIND_ACTIONS = ['thinking', 'toolOutput', 'pasteImage']`; `DEFAULT_KEYBINDS.pasteImage = 'alt+v'`. Test: tambah di `test/keybinds.test.ts`: `expect(load({}).keybinds.pasteImage.spec).toBe('alt+v')`. (Test `Unknown keybind action` yang lama memakai aksi `nope` → tetap valid.)

- [ ] **Step 4: UI wiring** — test `test/ui/pasteImage.test.tsx`:

```tsx
vi.mock('../../src/clipboardImage', () => ({ grabClipboardImage: vi.fn(async () => join(tmpdir(), 'fake-clip.png')) }))
// render App (pola redo.test), stdin.write('\x1bv')
// waitFor frame memuat 'fake-clip.png'
// assert notice + prompt input menampilkan path (frame mengandung path)
```

Implementasi:
- `src/ui/PromptInput.tsx`: prop `injected?: { text: string; n: number }`; `useEffect(() => { if (injected?.n) edit((current) => insert(current, injected.text)) }, [injected?.n])`.
- `src/ui/App.tsx`: state `const [injected, setInjected] = useState<{ text: string; n: number } | undefined>()`; branch useInput baru SEBELUM branch thinking:

```tsx
    } else if (matchKeybind(runtime.config.keybinds.pasteImage, input, key)) {
      void (async () => {
        const path = await grabClipboardImage({ platform: process.platform, tmpdir: tmpdir(), now: new Date(), run: undefined as never })
        if (path) {
          setInjected((prev) => ({ text: `${path} `, n: (prev?.n ?? 0) + 1 }))
          notice(t('Clipboard image saved to {path} — the path is inserted in the input; the model sees it when you send.', { path }))
        } else {
          notice(t('No image on the clipboard.'), 'warn')
        }
      })()
```

  (Gunakan signature `grabClipboardImage` dengan `run` opsional — sesuaikan `GrabDeps.run?`.) Teruskan `injected={injected}` ke `<PromptInput ... />`.
- id.ts: 2 key notice baru + terjemahan.

- [ ] **Step 5: Gates + canary live Windows + commit**
  - Canary: isi clipboard dengan gambar (`Add-Type System.Drawing/System.Windows.Forms; [Windows.Forms.Clipboard]::SetImage($bmp)`), jalankan TUI via `%TEMP%\opencode\pty-drive-local.py` dengan config `{"keybinds":{"pasteImage":"alt+v"}}`, kirim `\x1bv`, until path `bccli-clipboard-` muncul; verifikasi file PNG ada di temp.
  - `git add -A && git commit -m "feat: alt+v pastes a clipboard image into the prompt (win32/mac/linux)"`

---

### Task 5: Gates penuh, canary, dokumentasi

- [ ] **Step 1:** `npm test` (2×, stabil), `npm run typecheck`, `npm run lint`, `npm run build` — semua hijau.
- [ ] **Step 2:** Canary live: (a) `verifyCommands` via `bccli -p` di folder temp dengan perintah gagal → model dipanggil 2×; (b) `usageCap.tokens: 1` → turn kedua diblokir dengan pesan budget; (c) `bccli update` dry (spawn npm — boleh di-skip bila tidak mau install, cukup cek notice update muncul saat versi registry lebih baru); (d) paste gambar (Task 4 Step 5).
- [ ] **Step 3:** Update `~/.config/opencode/AGENTS.md` (section BCCLI): fitur baru, gotcha, status "release ditahan".
- [ ] **Step 4:** LAPOR ke user; JANGAN bump version/push/publish sampai user menyetujui rilis.

## Self-Review

- Spec coverage: #4 → Task 1; #12 → Task 2; #13 → Task 3; #6 → Task 4; commit beta.39 → Task 0; gates/AGENTS → Task 5. ✔
- Placeholder scan: tidak ada TBD; test code konkret; snippet integrasi konkret (runTurn App.tsx:139-158, print.ts:52, agent loop ~194, PromptInput prop). ✔
- Type consistency: `VerifyFailure`, `UsageCap`, `budgetStatus`, `GrabDeps`, `clipboardCommand`, `compareVersions/channelFor/dueForCheck/updateNotice/checkForUpdate/runUpdateCommand`, `KeybindAction += 'pasteImage'`, `PromptInput injected` — nama konsisten antar task. ✔
