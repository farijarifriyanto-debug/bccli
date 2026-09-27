import type { CliArgs } from './args'
import { type Config, loadConfig, saveCredential } from './config'
import { listAllModels } from './models'
import { PRESETS } from './presets'
import { hasKey, providerName, removeGlobalProvider, writeGlobalConfig } from './providers'

export interface CliDeps {
  env: NodeJS.ProcessEnv
  cwd: string
  out: (s: string) => void
  err: (s: string) => void
  readSecret: (prompt: string) => Promise<string>
  fetch?: typeof fetch
}

function keyEnv(config: Config, id: string, key: string): Record<string, string> {
  const name = config.providers[id]?.apiKeyEnv
  return name && key ? { [name]: key } : {}
}

export async function addProviderKey(
  providerId: string,
  key: string,
  deps: CliDeps,
): Promise<{ ok: true; models: number } | { ok: false; error: string }> {
  const config = loadConfig(deps.cwd, deps.env)
  const [group] = await listAllModels(config, { ...deps.env, ...keyEnv(config, providerId, key) }, { only: providerId, fetch: deps.fetch })
  if (!group || group.error) return { ok: false, error: `API key ditolak atau ${providerName(config, providerId)} tidak bisa dihubungi.` }
  if (key) saveCredential(providerId, key, deps.env)
  return { ok: true, models: group.models.length }
}

export async function runProviderCommand(args: CliArgs, deps: CliDeps): Promise<number> {
  const [action = 'list', id] = args.subArgs
  const config = loadConfig(deps.cwd, deps.env)
  if (action === 'list') {
    for (const pid of Object.keys(config.providers)) {
      const mark = hasKey(config, pid, deps.env) ? '✓' : '○'
      deps.out(`${mark} ${pid.padEnd(14)} ${providerName(config, pid).padEnd(20)} ${config.providers[pid].baseURL}`)
    }
    return 0
  }
  if (!id) {
    deps.err(`Pemakaian: bccli provider ${action} <id>`)
    return 1
  }
  if (action === 'remove') {
    removeGlobalProvider(id, deps.env)
    deps.out(`${id} dihapus.`)
    return 0
  }
  if (action !== 'add') {
    deps.err(`Aksi tidak dikenal: ${action}. Pakai list, add, atau remove.`)
    return 1
  }
  const preset = PRESETS.find((p) => p.id === id)
  if (!preset && !config.providers[id]) {
    if (!args.url) {
      deps.err(`${id} bukan preset. Untuk provider custom tambahkan --url <base URL OpenAI-compatible>.`)
      return 1
    }
    writeGlobalConfig(
      { providers: { [id]: { baseURL: args.url, ...(args.name ? { name: args.name } : {}), ...(args.keyEnv ? { apiKeyEnv: args.keyEnv } : {}) } } },
      deps.env,
    )
  }
  const needsKey = !!loadConfig(deps.cwd, deps.env).providers[id].apiKeyEnv || !preset
  const key = needsKey ? await deps.readSecret(`API key untuk ${id} (kosongkan bila tidak perlu): `) : ''
  const result = await addProviderKey(id, key, deps)
  if (!result.ok) {
    deps.err(result.error)
    return 1
  }
  deps.out(`${id} siap. ${result.models} model tersedia.`)
  return 0
}
