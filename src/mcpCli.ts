import type { CliArgs } from './args'
import { bccliHome } from './config'
import { CATALOG, fillTemplate } from './mcp/catalog'
import { addGlobalServer, globalMcpPath, readMcpFile, removeGlobalServer } from './mcp/config'
import { authorizeMcpServer, clearTokens } from './mcp/oauth'
import type { CliDeps } from './providerCli'
import { t } from './i18n'

export async function runMcpCommand(args: CliArgs, deps: CliDeps): Promise<number> {
  const home = bccliHome(deps.env)
  const [action = 'list', name] = args.subArgs
  const installed = readMcpFile(globalMcpPath(home))
  if (action === 'list') {
    for (const entry of CATALOG) deps.out(`${installed[entry.name] ? '✓' : '○'} ${entry.name.padEnd(12)} ${entry.description}`)
    for (const other of Object.keys(installed).filter((n) => !CATALOG.some((c) => c.name === n))) deps.out(`✓ ${other.padEnd(12)} (custom)`)
    return 0
  }
  if (!name) {
    deps.err(t('Usage: bccli mcp {action} <name>', { action }))
    return 1
  }
  if (action === 'remove') {
    removeGlobalServer(home, name)
    deps.out(t('{name} removed.', { name }))
    return 0
  }
  if (action === 'auth' || action === 'logout') {
    const config = installed[name]
    if (config?.type !== 'http') {
      deps.err(
        t('{name} is not an installed HTTP MCP server. Add it first with: bccli mcp add {name} --url <url>', { name }),
      )
      return 1
    }
    if (action === 'logout') {
      const removed = clearTokens(home, config.url)
      deps.out(removed ? t('{name} logged out.', { name }) : t('{name} has no stored OAuth tokens.', { name }))
      return 0
    }
    try {
      await authorizeMcpServer({ name, config }, { home })
      deps.out(t('{name} authorized. Active in the next bccli session.', { name }))
      return 0
    } catch (error) {
      deps.err(t('OAuth login failed for {name}: {reason}', { name, reason: (error as Error).message }))
      return 1
    }
  }
  if (action !== 'add') {
    deps.err(t('Unknown action: {action}. Use list, add, remove, auth, or logout.', { action }))
    return 1
  }
  if (args.url) {
    addGlobalServer(home, name, { type: 'http', url: args.url })
    deps.out(t('{name} installed ({url}).', { name, url: args.url }))
    return 0
  }
  const entry = CATALOG.find((c) => c.name === name)
  if (!entry) {
    deps.err(t('{name} is not in the catalog. For another remote server use: bccli mcp add {name} --url <url>', { name }))
    return 1
  }
  const values = Object.fromEntries(args.values.map((v) => [v.slice(0, v.indexOf('=')), v.slice(v.indexOf('=') + 1)]))
  // Secrets are prompted (hidden) instead of passed on the command line.
  for (const input of entry.inputs ?? []) {
    if (!values[input.key] && input.secret) values[input.key] = await deps.readSecret(`${input.label}: `)
  }
  try {
    addGlobalServer(home, name, fillTemplate(entry.config, values))
  } catch (error) {
    const hint = (entry.inputs ?? [])
      .filter((i) => !i.secret)
      .map((i) => `--value ${i.key}=…`)
      .join(' ')
    deps.err(`${(error as Error).message}${hint ? `. Contoh: bccli mcp add ${name} ${hint}` : ''}`)
    return 1
  }
  deps.out(t('{name} installed. Active in the next bccli session.', { name }))
  return 0
}
