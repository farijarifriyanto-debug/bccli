import { helpText, parseCliArgs } from './args'
import { ConfigError } from './config'
import { runLogin } from './login'
import { runPrint } from './print'
import { readGlobalConfigFile } from './providers'
import { pruneSessions } from './session'
import { createRuntime } from './setup'
import { setTheme } from './ui/theme'
import { VERSION } from './version'
import { resolveLanguage, setLanguage, t } from './i18n'
import { resolveWorktree } from './worktree'

function chooseLanguage(argv: string[]): void {
  let fromConfig: string | undefined
  try {
    fromConfig = readGlobalConfigFile(process.env).language
  } catch {
    // a broken config is reported later, in the right language
  }
  setLanguage(resolveLanguage(argv, process.env, fromConfig))
}

async function main(): Promise<number> {
  chooseLanguage(process.argv.slice(2))
  const args = parseCliArgs(process.argv.slice(2))
  if (args.version) {
    console.log(VERSION)
    return 0
  }
  if (args.help) {
    console.log(helpText())
    return 0
  }
  let cwd = process.cwd()
  if (args.worktree) cwd = (await resolveWorktree(cwd, args.worktree)).path
  if (args.command === 'login') return runLogin(args.loginProvider ?? 'bc-cloud', cwd)
  if (args.command === 'mcp') {
    const { runMcpCommand } = await import('./mcpCli')
    const { readSecret } = await import('./login')
    return runMcpCommand(args, { env: process.env, cwd, out: (s) => console.log(s), err: (s) => console.error(s), readSecret })
  }
  if (args.command === 'provider') {
    const { runProviderCommand } = await import('./providerCli')
    const { readSecret } = await import('./login')
    return runProviderCommand(args, { env: process.env, cwd, out: (s) => console.log(s), err: (s) => console.error(s), readSecret })
  }
  if (args.command === 'connect' || args.command === 'disconnect' || args.command === 'integrations') {
    const { runIntegrationCommand } = await import('./integrationCli')
    return runIntegrationCommand(args, {
      env: process.env,
      cwd,
      out: (s) => console.log(s),
      err: (s) => console.error(s),
      fetch: globalThis.fetch,
    })
  }
  if (args.command === 'models') {
    const { runModelsCommand } = await import('./modelsCli')
    return runModelsCommand(args, { env: process.env, cwd, out: (s) => console.log(s), err: (s) => console.error(s), fetch: globalThis.fetch })
  }
  if (args.command === 'update') {
    const { runUpdateCommand } = await import('./update')
    return runUpdateCommand({ env: process.env })
  }
  if (args.command === 'acp') {
    const { runtimeAgent, runAcp } = await import('./acp')
    await runAcp(process.stdin, process.stdout, { cwd, newAgent: (c) => runtimeAgent(c) })
    return 0
  }
  if (args.command === 'serve') {
    const { startServe } = await import('./serve')
    const handle = await startServe({ port: args.port, host: args.host, token: args.token, cwd, env: process.env })
    process.stderr.write(`bccli serve ${handle.url} — Authorization: Bearer ${handle.token}\n`)
    await new Promise<void>((resolve) => {
      const stop = (): void => {
        void handle.close().finally(resolve)
      }
      process.once('SIGINT', stop)
      process.once('SIGTERM', stop)
    })
    return 0
  }
  if (args.command === 'plugins') {
    const { runPluginsCommand } = await import('./pluginsCli')
    const { readGlobalPlugins, updateGlobalConfig } = await import('./config')
    const runNpm = async (prefix: string, argv: string[]) => {
      const { spawnSync } = await import('node:child_process')
      const opts = { encoding: 'utf8' } as const
      // win32: .cmd tanpa shell = EINVAL di Node modern (CVE-2024-27980) → shell:true.
      // Quote HANYA argumen ber-spasi: mem-quote SEMUA token membuat cmd /s membuang
      // quote eksternal pertama-terakhir → argumen kacau (terbukti canary, probe).
      const q = (a: string): string => (/\s/.test(a) ? `"${a}"` : a)
      const r =
        process.platform === 'win32'
          ? spawnSync(['npm.cmd', '--prefix', prefix, ...argv].map(q).join(' '), { ...opts, shell: true })
          : spawnSync('npm', ['--prefix', prefix, ...argv], opts)
      return { code: r.status ?? 1, stderr: r.stderr || (r.error ? r.error.message : '') }
    }
    return runPluginsCommand(args, {
      out: (s) => console.log(s),
      err: (s) => console.error(s),
      env: process.env,
      runNpm,
      readPlugins: () => readGlobalPlugins(process.env),
      savePlugins: (entries) =>
        updateGlobalConfig(process.env, (cfg) => {
          cfg.plugins = entries
        }),
    })
  }
  const rt = createRuntime({ cwd, args })
  setTheme(rt.config.theme)
  try {
    pruneSessions(rt.home)
  } catch {
    // pruning is best effort
  }
  if (args.print) {
    if (!args.prompt) throw new ConfigError(t('-p mode needs a task, e.g. bccli -p "explain this repo"'))
    const { serversToStart } = await import('./mcp/config')
    const plan = serversToStart(rt.home, cwd)
    for (const s of plan.needTrust) {
      console.error(t('Project MCP server "{name}" skipped (not approved yet; run interactive bccli once to approve it).', { name: s.name }))
    }
    await rt.startMcp(plan.start)
    try {
      return await runPrint(rt, args.prompt, undefined, { allowAll: args.allowAll, outputFormat: args.outputFormat })
    } finally {
      await rt.mcp.stop()
    }
  }
  if (!process.stdin.isTTY) throw new ConfigError(t('Interactive mode needs a terminal. For scripts/CI use: bccli -p "task"'))
  if (rt.config.updateCheck !== 'off' && !process.env.BCCLI_NO_UPDATE_CHECK) {
    try {
      const { checkForUpdate } = await import('./update')
      const update = await checkForUpdate({ home: rt.home, fetch: globalThis.fetch, now: new Date() })
      if (update) console.error(update)
    } catch {
      // update checks are best effort and must never block startup
    }
  }
  const { startInteractive } = await import('./ui/index')
  return startInteractive(rt, { initialPrompt: args.prompt, resume: args.resume, version: VERSION })
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error instanceof ConfigError || error?.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION' ? error.message : error)
    process.exit(1)
  },
)
