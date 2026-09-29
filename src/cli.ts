import { HELP_TEXT, parseCliArgs } from './args'
import { ConfigError, loadConfig, resolveModel } from './config'
import { runLogin } from './login'
import { runPrint } from './print'
import { createProvider } from './provider'
import { pruneSessions } from './session'
import { createRuntime } from './setup'
import { VERSION } from './version'

async function main(): Promise<number> {
  const args = parseCliArgs(process.argv.slice(2))
  if (args.version) {
    console.log(VERSION)
    return 0
  }
  if (args.help) {
    console.log(HELP_TEXT)
    return 0
  }
  const cwd = process.cwd()
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
    const config = loadConfig(cwd)
    const resolved = resolveModel(config, args.model ?? config.model)
    const models = await createProvider(resolved).listModels()
    console.log(models.map((m) => `${resolved.providerId}/${m}`).join('\n'))
    return 0
  }
  const rt = createRuntime({ cwd, args })
  try {
    pruneSessions(rt.home)
  } catch {
    // pruning is best effort
  }
  if (args.print) {
    if (!args.prompt) throw new ConfigError('Mode -p butuh tugas, contoh: bccli -p "jelaskan repo ini"')
    const { serversToStart } = await import('./mcp/config')
    const plan = serversToStart(rt.home, cwd)
    for (const s of plan.needTrust) {
      console.error(`Server MCP project "${s.name}" dilewati (belum diizinkan; jalankan bccli interaktif sekali untuk menyetujuinya).`)
    }
    await rt.startMcp(plan.start)
    try {
      return await runPrint(rt, args.prompt, undefined, { allowAll: args.allowAll })
    } finally {
      await rt.mcp.stop()
    }
  }
  if (!process.stdin.isTTY) throw new ConfigError('Mode interaktif butuh terminal. Untuk skrip/CI pakai: bccli -p "tugas"')
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
