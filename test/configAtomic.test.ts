import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { ConfigError, globalConfigPath, readGlobalPlugins, updateGlobalConfig } from '../src/config'

const env = () => ({ BCCLI_HOME: mkdtempSync(join(tmpdir(), 'bccli-cfg-')) } as NodeJS.ProcessEnv)

test('updateGlobalConfig: file belum ada â†’ dibuat dengan hasil mutate', () => {
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

test('updateGlobalConfig: mutate throw â†’ file tidak berubah, tidak ada sisa .tmp', () => {
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

test('readGlobalPlugins: file tak ada â†’ []; tipe salah â†’ ConfigError; JSON korup â†’ ConfigError', () => {
  const e = env()
  expect(readGlobalPlugins(e)).toEqual([])
  writeFileSync(globalConfigPath(e), JSON.stringify({ plugins: 'nope' }))
  expect(() => readGlobalPlugins(e)).toThrow(/plugins/)
  writeFileSync(globalConfigPath(e), '{corrupt')
  // Assertion lintas-bahasa: path selalu muncul, apa pun katalog (EN/ID) yang aktif.
  expect(() => readGlobalPlugins(e)).toThrow('config.json')
})

test('updateGlobalConfig: JSON korup â†’ ConfigError berisi path, file tidak diubah atau dipindah', () => {
  const e = env()
  writeFileSync(globalConfigPath(e), '{corrupt')
  expect(() =>
    updateGlobalConfig(e, (cfg) => {
      cfg.plugins = []
    }),
  ).toThrow(ConfigError)
  expect(() =>
    updateGlobalConfig(e, (cfg) => {
      cfg.plugins = []
    }),
  ).toThrow('config.json')
  // config.json milik user: jangan di-reset dan jangan dikarantina diam-diam saat menulis.
  expect(readFileSync(globalConfigPath(e), 'utf8')).toBe('{corrupt')
  expect(readdirSync(join(e.BCCLI_HOME as string)).filter((f) => f.includes('corrupt-'))).toEqual([])
})
