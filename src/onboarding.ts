import type { CliArgs } from './args'
import type { Config } from './config'
import { hasKey } from './providers'

/** Offer the built-in provider key prompt only for interactive, unconfigured runs.
 * A print/CI invocation must never block waiting for secret input.
 */
export function firstRunKeyProvider(
  args: CliArgs,
  config: Config,
  env: NodeJS.ProcessEnv,
  isTTY: boolean,
): string | undefined {
  if (!isTTY || args.command !== 'run' || args.print) return undefined
  const modelRef = args.model ?? config.model
  const providerId = modelRef.slice(0, modelRef.indexOf('/'))
  if (!providerId || !config.providers[providerId]?.apiKeyEnv) return undefined
  return hasKey(config, providerId, env) ? undefined : providerId
}
