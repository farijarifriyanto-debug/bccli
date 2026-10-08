import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { parseCliArgs } from '../src/args'
import { bccliHome, globalConfigPath, readGlobalPlugins, updateGlobalConfig } from '../src/config'
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

// Deviasi plan→aktual: build CliArgs eksplisit agar unit test Task 3 tidak bergantung
// pada wiring args.ts (Task 4). parsing end-to-end diuji di test/args.test.ts Task 4.
const run = (argv: string[], deps: PluginsDeps) =>
  runPluginsCommand({ ...parseCliArgs([]), command: 'plugins', subArgs: argv.slice(1) }, deps)

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

test('Integrasi (Aturan 2+4 end-to-end): install 2× dengan config ASLI → 1 entry, kunci lain utuh', async () => {
  const h = harness()
  const e = h.deps.env
  writeFileSync(globalConfigPath(e), JSON.stringify({ model: 'gmi/x' }))
  const real: PluginsDeps = {
    ...h.deps,
    readPlugins: () => readGlobalPlugins(e),
    savePlugins: (x) =>
      updateGlobalConfig(e, (cfg) => {
        cfg.plugins = x
      }),
  }
  expect(await run(['plugins', 'install', 'foo'], real)).toBe(0)
  expect(await run(['plugins', 'install', 'foo'], real)).toBe(0)
  expect(readGlobalPlugins(e)).toEqual([managed('foo')])
  const raw = JSON.parse(readFileSync(globalConfigPath(e), 'utf8')) as Record<string, unknown>
  expect(raw.model).toBe('gmi/x') // kunci lain dipertahankan (write atomik)
  expect(h.npmCalls).toHaveLength(2) // npm jalan dua kali, config ditulis efektif 1 entry
})
