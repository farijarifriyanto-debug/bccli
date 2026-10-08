import type { CliArgs } from './args'
import { globalConfigPath, readJsonConfig } from './config'
import { ghBotConfigFrom } from './ghBotDispatch'
import { startGhBot } from './ghBotServe'
import { t } from './i18n'

export interface GhBotCliDeps {
  env: NodeJS.ProcessEnv
  cwd: string
  out(s?: string): void
  err(s?: string): void
}

/** `bccli gh-bot [serve]` — off-by-default; secret dari env accessor per-request. */
export async function runGhBotCommand(args: CliArgs, deps: GhBotCliDeps): Promise<number> {
  const [action = 'serve'] = args.subArgs
  if (action !== 'serve') {
    deps.err(t('Unknown action: {action}. Use serve.', { action }))
    return 1
  }
  const raw = readJsonConfig(globalConfigPath(deps.env)) as { githubBot?: unknown }
  const config = ghBotConfigFrom(raw.githubBot)
  const getSecret = () => deps.env[config.secretEnv]
  const handle = await startGhBot({
    port: args.port ?? 18790,
    host: '127.0.0.1',
    config,
    getSecret,
    env: deps.env,
    out: deps.out,
    err: deps.err,
  })
  // Banner TANPA nilai secret (hanya keadaan terdeteksi).
  deps.out(`bccli gh-bot listening on http://127.0.0.1:${handle.port}${config.path}`)
  deps.out(`enabled=${config.enabled} secret=${getSecret() ? 'detected' : 'missing'}`)
  await new Promise<void>((resolve) => {
    const stop = (): void => {
      void handle.close().then((summary) => {
        deps.out(`gh-bot stopped — aborted=${summary.aborted} confirmed=${summary.terminationConfirmed} unconfirmed=${summary.terminationUnconfirmed}`)
        resolve()
      })
    }
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
  })
  return 0
}
