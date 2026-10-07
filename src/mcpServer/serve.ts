import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { CliArgs } from '../args'
import { loadConfig, readCredentials } from '../config'
import { t } from '../i18n'
import type { CliDeps } from '../providerCli'
import { createMcpServer } from './server'

const DEFAULT_BASE = 'https://api.botconnector.id/v1'
const FALLBACK_MODEL = 'glm-5.3-flash'

export interface McpServeDeps extends CliDeps {
  /** Test seam: replaces the stdio transport (pass an InMemoryTransport half). */
  transport?: Transport
}

export async function runMcpServe(args: CliArgs, deps: McpServeDeps): Promise<number> {
  const apiKey = readCredentials(deps.env)['bc-cloud'] || deps.env.BOTCONNECTOR_API_KEY
  if (!apiKey) {
    deps.err(t('No BotConnector API key yet. Run bccli login bc-cloud first.'))
    return 1
  }
  const config = loadConfig(deps.cwd, deps.env)
  const providerBase = config.providers['bc-cloud']?.baseURL ?? DEFAULT_BASE
  const baseUrl = (args.baseUrl ?? providerBase).replace(/\/+$/, '')
  const defaultModel = config.model.startsWith('bc-cloud/')
    ? config.model.slice('bc-cloud/'.length)
    : FALLBACK_MODEL

  const server = createMcpServer({ baseUrl, apiKey, defaultModel, fetchFn: deps.fetch })
  await server.connect(deps.transport ?? new StdioServerTransport())
  deps.err(`mcp serve: 4 tools, base=${baseUrl}`)

  if (deps.transport) return 0
  await new Promise<void>((resolve) => {
    const stdin = process.stdin
    stdin.on('end', () => resolve())
    stdin.on('close', () => resolve())
  })
  return 0
}
