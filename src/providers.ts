import { join } from 'node:path'
import { bccliHome, type Config, readCredentials, readJsonConfig, removeCredential, writeFileAtomic } from './config'
import { PRESETS } from './presets'

export function providerName(config: Config, id: string): string {
  return PRESETS.find((p) => p.id === id)?.name ?? config.providers[id]?.name ?? id
}

export function hasKey(config: Config, id: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const provider = config.providers[id]
  if (!provider) return false
  if (!provider.apiKeyEnv) return true
  return !!env[provider.apiKeyEnv] || !!savedCredential(id, env)
}

/**
 * Provider BotConnector Cloud pernah memakai dua id: `bc-cloud` di kode ini dan `botconnector`
 * di rilis 0.5.2. Keduanya harus saling mengenali, kalau tidak kunci yang tersimpan di bawah
 * satu nama tidak terbaca saat id yang aktif memakai nama lain (provider tampak "○" tanpa kunci).
 */
export function providerIdAliases(id: string): readonly string[] {
  if (id === 'bc-cloud') return ['botconnector']
  if (id === 'botconnector') return ['bc-cloud']
  return []
}

/** Kunci tersimpan untuk `id`, termasuk yang tersimpan di bawah nama aliasnya. */
export function savedCredential(id: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const creds = readCredentials(env)
  for (const candidate of [id, ...providerIdAliases(id)]) {
    const key = creds[candidate]
    if (typeof key === 'string' && key.length > 0) return key
  }
  return undefined
}

const globalPath = (env: NodeJS.ProcessEnv) => join(bccliHome(env), 'config.json')

export function readGlobalConfigFile(env: NodeJS.ProcessEnv = process.env): Partial<Config> {
  return readJsonConfig(globalPath(env))
}

function save(data: Partial<Config>, env: NodeJS.ProcessEnv): void {
  writeFileAtomic(globalPath(env), `${JSON.stringify(data, null, 2)}\n`)
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
