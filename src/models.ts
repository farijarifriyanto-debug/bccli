import { type Config, readCredentials } from './config'
import { PRESETS } from './presets'
import { createProvider } from './provider'
import { hasKey, providerName } from './providers'

export interface ModelGroup {
  providerId: string
  providerName: string
  models: string[]
  error?: string
}

function order(ids: string[]): string[] {
  const presetIds = PRESETS.map((p) => p.id)
  const presets = presetIds.filter((id) => ids.includes(id))
  const custom = ids.filter((id) => !presetIds.includes(id)).sort()
  return [...presets, ...custom]
}

export async function listAllModels(
  config: Config,
  env: NodeJS.ProcessEnv = process.env,
  opts: { fetch?: typeof fetch; timeoutMs?: number; only?: string } = {},
): Promise<ModelGroup[]> {
  const timeoutMs = opts.timeoutMs ?? 5000
  const baseFetch = opts.fetch ?? fetch
  const ids = order(Object.keys(config.providers)).filter((id) => (opts.only ? id === opts.only : hasKey(config, id, env)))
  const results = await Promise.all(
    ids.map(async (id): Promise<ModelGroup | undefined> => {
      const provider = config.providers[id]
      const apiKey = (provider.apiKeyEnv ? env[provider.apiKeyEnv] : undefined) || readCredentials(env)[id] || undefined
      const local = !provider.apiKeyEnv
      const timedFetch = ((input: string | URL | Request, init?: RequestInit) =>
        baseFetch(input, { ...init, signal: AbortSignal.timeout(timeoutMs) })) as typeof fetch
      const list = createProvider({ baseURL: provider.baseURL.replace(/\/+$/, ''), apiKey, model: '', fetch: timedFetch }).listModels()
      let timer: NodeJS.Timeout | undefined
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), timeoutMs)
      })
      try {
        const models = await Promise.race([list, timeout])
        return { providerId: id, providerName: providerName(config, id), models }
      } catch {
        // Local servers that are not running are simply not shown.
        if (local && !opts.only) return undefined
        return { providerId: id, providerName: providerName(config, id), models: [], error: 'tidak bisa dihubungi' }
      } finally {
        clearTimeout(timer)
      }
    }),
  )
  return results.filter((g): g is ModelGroup => !!g)
}
