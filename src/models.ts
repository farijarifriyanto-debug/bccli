import type { Config } from './config'
import { PRESETS } from './presets'
import { createProvider, ProviderError } from './provider'
import { hasKey, providerName, savedCredential } from './providers'
import { t } from './i18n'

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
  opts: { fetch?: typeof fetch; timeoutMs?: number; only?: string; keyOverride?: string } = {},
): Promise<ModelGroup[]> {
  const timeoutMs = opts.timeoutMs ?? 5000
  const baseFetch = opts.fetch ?? fetch
  // Keyless providers from a cloned repo's config are only contacted when explicitly selected.
  const untrusted = new Set(config.projectProviders ?? [])
  const ids = order(Object.keys(config.providers)).filter((id) => (opts.only ? id === opts.only : !untrusted.has(id) && hasKey(config, id, env)))
  const results = await Promise.all(
    ids.map(async (id): Promise<ModelGroup | undefined> => {
      const provider = config.providers[id]
      const apiKey =
        (opts.keyOverride && id === opts.only ? opts.keyOverride : undefined) ||
        savedCredential(id, env) ||
        (provider.apiKeyEnv ? env[provider.apiKeyEnv] : undefined) ||
        undefined
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
      } catch (error) {
        // Local servers that are not running are simply not shown.
        if (local && !opts.only) return undefined
        return { providerId: id, providerName: providerName(config, id), models: [], error: failureDetail(error) }
      } finally {
        clearTimeout(timer)
      }
    }),
  )
  return results.filter((g): g is ModelGroup => !!g)
}

/**
 * Sebab kegagalan yang bisa ditindaklanjuti. Sebelumnya setiap kegagalan dilaporkan sebagai
 * "tidak bisa dihubungi", sehingga kunci yang ditolak (401), kuota habis (429), atau endpoint
 * salah (404) tampak sama saja dan pengguna tidak tahu apa yang harus diperbaiki.
 * Status HTTP diambil dari ProviderError; kegagalan jaringan/timeout tetap generik karena
 * tidak ada status yang bisa dilaporkan.
 */
function failureDetail(error: unknown): string {
  if (error instanceof ProviderError && typeof error.status === 'number') {
    return t('{status} while fetching the model list', { status: error.status })
  }
  return t('could not be reached')
}
