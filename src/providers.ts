import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { bccliHome, type Config, readCredentials, readJsonConfig, removeCredential } from './config'
import { PRESETS } from './presets'

export function providerName(config: Config, id: string): string {
  return PRESETS.find((p) => p.id === id)?.name ?? config.providers[id]?.name ?? id
}

export function hasKey(config: Config, id: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const provider = config.providers[id]
  if (!provider) return false
  if (!provider.apiKeyEnv) return true
  return !!env[provider.apiKeyEnv] || !!readCredentials(env)[id]
}

const globalPath = (env: NodeJS.ProcessEnv) => join(bccliHome(env), 'config.json')

export function readGlobalConfigFile(env: NodeJS.ProcessEnv = process.env): Partial<Config> {
  return readJsonConfig(globalPath(env))
}

function save(data: Partial<Config>, env: NodeJS.ProcessEnv): void {
  mkdirSync(bccliHome(env), { recursive: true })
  writeFileSync(globalPath(env), `${JSON.stringify(data, null, 2)}\n`)
}

export function writeGlobalConfig(patch: Partial<Config>, env: NodeJS.ProcessEnv = process.env): void {
  const current = readGlobalConfigFile(env)
  const next: Partial<Config> = { ...current, ...patch }
  if (patch.providers) next.providers = { ...current.providers, ...patch.providers }
  save(next, env)
}

export function removeGlobalProvider(id: string, env: NodeJS.ProcessEnv = process.env): void {
  removeCredential(id, env)
  const current = readGlobalConfigFile(env)
  if (!current.providers?.[id]) return
  const { [id]: _removed, ...providers } = current.providers
  save({ ...current, providers }, env)
}
