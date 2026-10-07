import type { CliArgs } from './args'
import { loadConfig, resolveModel } from './config'
import { listAllModels } from './models'
import { t } from './i18n'

export interface ModelsDeps {
  env: NodeJS.ProcessEnv
  cwd: string
  out(line: string): void
  err(line: string): void
  fetch?: typeof fetch
}

/**
 * `bccli models [provider|provider/model]`.
 * No argument keeps the old behavior: list the models of the active provider.
 * A provider id (or a full model ref, whose provider part is used) lists exactly
 * that provider, even when it is keyless or comes from the project config.
 */
export async function runModelsCommand(args: CliArgs, deps: ModelsDeps): Promise<number> {
  const config = loadConfig(deps.cwd, deps.env)
  const arg = (args.subArgs[0] ?? '').trim()
  const providerId = arg ? arg.split('/')[0] : resolveModel(config, args.model ?? config.model, deps.env).providerId
  if (!Object.hasOwn(config.providers, providerId)) {
    deps.err(t('Provider "{id}" is not in the config. Available: {list}', { id: providerId, list: Object.keys(config.providers).join(', ') }))
    return 1
  }
  const groups = await listAllModels(config, deps.env, { fetch: deps.fetch, only: providerId })
  const group = groups.find((g) => g.providerId === providerId)
  if (!group || group.error) {
    deps.err(`${providerId}: ${group?.error ?? t('could not be reached')}`)
    return 1
  }
  deps.out(group.models.map((m) => `${providerId}/${m}`).join('\n'))
  return 0
}
