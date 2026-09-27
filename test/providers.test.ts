import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, expect, test } from 'vitest'
import { loadConfig, readCredentials, saveCredential } from '../src/config'
import { PRESETS } from '../src/presets'
import { hasKey, providerName, removeGlobalProvider, writeGlobalConfig } from '../src/providers'

let env: NodeJS.ProcessEnv
let cwd: string
beforeEach(() => {
  env = { BCCLI_HOME: mkdtempSync(join(tmpdir(), 'bccli-pv-')) }
  cwd = mkdtempSync(join(tmpdir(), 'bccli-pc-'))
})

test('all presets are available without any config file', () => {
  const config = loadConfig(cwd, env)
  expect(PRESETS.map((p) => p.id)).toEqual(['bc-cloud', 'openrouter', 'openai', 'gemini', 'deepseek', 'groq', 'ollama-cloud', 'ollama', 'lmstudio'])
  for (const p of PRESETS) expect(config.providers[p.id].baseURL).toBe(p.baseURL)
  expect(providerName(config, 'gemini')).toBe('Google Gemini')
  expect(providerName(config, 'unknown')).toBe('unknown')
})

test('hasKey: env, credentials file, or keyless local provider', () => {
  const config = loadConfig(cwd, env)
  expect(hasKey(config, 'openai', env)).toBe(false)
  expect(hasKey(config, 'openai', { ...env, OPENAI_API_KEY: 'x' })).toBe(true)
  saveCredential('groq', 'g', env)
  expect(hasKey(config, 'groq', env)).toBe(true)
  expect(hasKey(config, 'ollama', env)).toBe(true)
})

test('writeGlobalConfig merges providers and keeps presets out of the file', () => {
  writeGlobalConfig({ model: 'openai/gpt-4.1' }, env)
  writeGlobalConfig({ providers: { corp: { baseURL: 'https://corp/v1', name: 'Corp' } } }, env)
  writeGlobalConfig({ providers: { other: { baseURL: 'https://o/v1' } } }, env)
  const raw = JSON.parse(readFileSync(join(env.BCCLI_HOME!, 'config.json'), 'utf8'))
  expect(raw).toEqual({ model: 'openai/gpt-4.1', providers: { corp: { baseURL: 'https://corp/v1', name: 'Corp' }, other: { baseURL: 'https://o/v1' } } })
  expect(providerName(loadConfig(cwd, env), 'corp')).toBe('Corp')
})

test('removeGlobalProvider drops custom entries and credentials; presets keep their entry', () => {
  writeGlobalConfig({ providers: { corp: { baseURL: 'https://corp/v1' } } }, env)
  saveCredential('corp', 'k', env)
  saveCredential('openai', 'k2', env)
  removeGlobalProvider('corp', env)
  removeGlobalProvider('openai', env)
  expect(loadConfig(cwd, env).providers.corp).toBeUndefined()
  expect(loadConfig(cwd, env).providers.openai).toBeDefined()
  expect(readCredentials(env)).toEqual({})
})

test('a corrupt global config is reported, not overwritten', () => {
  writeFileSync(join(env.BCCLI_HOME!, 'config.json'), '{bad')
  expect(() => writeGlobalConfig({ model: 'a/b' }, env)).toThrow(/Config tidak valid/)
})
