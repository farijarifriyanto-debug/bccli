import { mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, expect, test } from 'vitest'
import { ConfigError, loadConfig, readCredentials, resolveModel, saveCredential } from '../src/config'

let home: string
let project: string
let env: NodeJS.ProcessEnv

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'bccli-home-'))
  project = mkdtempSync(join(tmpdir(), 'bccli-proj-'))
  env = { BCCLI_HOME: home }
})

test('defaults to BotConnector Cloud', () => {
  const config = loadConfig(project, env)
  expect(config.model).toBe('bc-cloud/glm-5.3-flash')
  expect(config.permissionMode).toBe('default')
  expect(config.providers['bc-cloud'].baseURL).toBe('https://api.botconnector.id/v1')
})

test('project config overrides global, providers merge, allow concatenates', () => {
  writeFileSync(join(home, 'config.json'), JSON.stringify({ model: 'a/x', allow: ['edit'], providers: { a: { baseURL: 'http://a' } } }))
  mkdirSync(join(project, '.bccli'))
  writeFileSync(join(project, '.bccli', 'config.json'), JSON.stringify({ model: 'b/y', allow: ['bash(npm test)'], providers: { b: { baseURL: 'http://b' } } }))
  const config = loadConfig(project, env)
  expect(config.model).toBe('b/y')
  expect(Object.keys(config.providers).sort()).toEqual(['a', 'b', 'bc-cloud'])
  expect(config.allow).toEqual(['edit', 'bash(npm test)'])
})

test('invalid JSON gives a ConfigError naming the file', () => {
  writeFileSync(join(home, 'config.json'), '{nope')
  expect(() => loadConfig(project, env)).toThrow(ConfigError)
  expect(() => loadConfig(project, env)).toThrow(/config\.json/)
})

test('resolveModel splits at the first slash and reads the key from env', () => {
  const config = loadConfig(project, { ...env })
  const r = resolveModel(config, 'bc-cloud/stealth/space-bunny-alpha', { ...env, BOTCONNECTOR_API_KEY: 'k1' })
  expect(r).toEqual({ providerId: 'bc-cloud', model: 'stealth/space-bunny-alpha', baseURL: 'https://api.botconnector.id/v1', apiKey: 'k1' })
})

test('resolveModel falls back to the credentials file; env wins', () => {
  saveCredential('bc-cloud', 'from-file', env)
  const config = loadConfig(project, env)
  expect(resolveModel(config, 'bc-cloud/m', env).apiKey).toBe('from-file')
  expect(resolveModel(config, 'bc-cloud/m', { ...env, BOTCONNECTOR_API_KEY: 'from-env' }).apiKey).toBe('from-env')
})

test('missing API key explains bccli login and the env var', () => {
  const config = loadConfig(project, env)
  expect(() => resolveModel(config, 'bc-cloud/m', env)).toThrow(/bccli login.*BOTCONNECTOR_API_KEY/s)
})

test('providers without apiKeyEnv need no key', () => {
  writeFileSync(join(home, 'config.json'), JSON.stringify({ providers: { local: { baseURL: 'http://127.0.0.1:11434/v1/' } } }))
  const r = resolveModel(loadConfig(project, env), 'local/qwen3', env)
  expect(r.baseURL).toBe('http://127.0.0.1:11434/v1')
  expect(r.apiKey).toBeUndefined()
})

test('bad model refs and unknown providers are ConfigErrors', () => {
  const config = loadConfig(project, env)
  expect(() => resolveModel(config, 'glm', env)).toThrow(/provider\/model/)
  expect(() => resolveModel(config, 'nope/x', env)).toThrow(/Provider "nope"/)
})

test('credentials file is written with mode 600', () => {
  saveCredential('bc-cloud', 'secret', env)
  expect(readCredentials(env)).toEqual({ 'bc-cloud': 'secret' })
  if (process.platform !== 'win32') expect(statSync(join(home, 'credentials')).mode & 0o777).toBe(0o600)
})
