import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { z } from 'zod'
import type { Tool } from '../tools/types'
import type { McpServerSpec } from './config'
import { expandEnvVars } from './config'
import { FileOAuthProvider, hasStoredTokens } from './oauth'
import { t } from '../i18n'

const MCP_OUTPUT_MAX_CHARS = 32_000

/**
 * Env vars a stdio MCP child may inherit from the parent CLI. The parent can hold
 * provider API keys and tokens in process.env; those must not leak to every spawned
 * server (the stdio transport receives a full env object, so the MCP SDK's own safe
 * defaults get overwritten by whatever we pass here).
 */
const CHILD_ENV_KEYS = [
  // portable
  'PATH',
  'HOME',
  'USERPROFILE',
  'LANG',
  'LC_ALL',
  'TZ',
  'TMP',
  'TEMP',
  'TMPDIR',
  // windows
  'SYSTEMROOT',
  'SYSTEMDRIVE',
  'COMSPEC',
  'PATHEXT',
  'APPDATA',
  'LOCALAPPDATA',
  'HOMEDRIVE',
  'HOMEPATH',
  'USERNAME',
  'PROGRAMFILES',
  'PROCESSOR_ARCHITECTURE',
  // posix
  'LOGNAME',
  'SHELL',
  'TERM',
  'USER',
] as const

/** Safe env for spawned MCP servers: whitelist from the parent + the server's own config.env. */
export function mcpChildEnv(extra?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const key of CHILD_ENV_KEYS) {
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }
  return { ...env, ...extra }
}

export interface McpServerState {
  name: string
  source: 'global' | 'project'
  status: 'starting' | 'ready' | 'error'
  error?: string
  tools: number
}

/** OpenAI function names: [A-Za-z0-9_-], max 64 chars, unique. */
export function mcpToolName(server: string, tool: string, taken: Set<string>): string {
  const clean = (s: string) => s.replace(/[^A-Za-z0-9_-]+/g, '_')
  const base = `mcp__${clean(server)}__${clean(tool)}`.slice(0, 64)
  let name = base
  for (let n = 2; taken.has(name); n++) name = `${base.slice(0, 64 - String(n).length - 1)}_${n}`
  taken.add(name)
  return name
}

interface Connected {
  spec: McpServerSpec
  state: McpServerState
  client?: Client
  tools: Tool[]
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(t('timeout after {n} seconds', { n: Math.round(ms / 1000) }))), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

export class McpManager {
  private readonly servers = new Map<string, Connected>()
  private readonly taken = new Set<string>()

  constructor(
    private readonly opts: {
      connectTimeoutMs?: number
      onChange?: () => void
      onToolsRemoved?: (names: string[]) => void
      /** Config home for the OAuth token store; enables authProvider on http servers. */
      home?: string
      /** Overrides how the OAuth consent page is opened (tests inject a fake browser). */
      open?: (url: URL) => void | Promise<void>
    } = {},
  ) {}

  async start(specs: McpServerSpec[]): Promise<void> {
    await Promise.all(specs.map((spec) => this.add(spec)))
  }

  async add(spec: McpServerSpec): Promise<void> {
    await this.remove(spec.name)
    const entry: Connected = { spec, state: { name: spec.name, source: spec.source, status: 'starting', tools: 0 }, tools: [] }
    this.servers.set(spec.name, entry)
    this.opts.onChange?.()
    const client = new Client({ name: 'bccli', version: '0.3.0' })
    entry.client = client // so remove() during connect can close it
    const timeoutMs = this.opts.connectTimeoutMs ?? 30_000
    try {
      const config = expandEnvVars(spec.config, process.env)
      let transport: StdioClientTransport | StreamableHTTPClientTransport
      if (config.type === 'http') {
        const oauth =
          this.opts.home && (config.auth === 'oauth' || hasStoredTokens(this.opts.home, config.url))
            ? new FileOAuthProvider({ home: this.opts.home, serverUrl: config.url, open: this.opts.open })
            : undefined
        transport = new StreamableHTTPClientTransport(new URL(config.url), {
          requestInit: { headers: config.headers ?? {} },
          ...(oauth ? { authProvider: oauth } : {}),
        })
      } else {
        transport = new StdioClientTransport({
          command: config.command,
          args: config.args ?? [],
          env: mcpChildEnv(config.env),
          stderr: 'ignore',
        })
      }
      await withTimeout(client.connect(transport), timeoutMs)
      const { tools } = await withTimeout(client.listTools(), timeoutMs)
      if (this.servers.get(spec.name) !== entry) {
        await client.close().catch(() => {})
        return
      }
      entry.tools = tools.map((t) => this.wrap(spec.name, client, t))
      entry.state = { ...entry.state, status: 'ready', tools: entry.tools.length }
    } catch (error) {
      if (error instanceof UnauthorizedError) {
        entry.state = {
          ...entry.state,
          status: 'error',
          error: t('OAuth required for {name}: run bccli mcp auth {name}', { name: spec.name }),
        }
      } else {
        entry.state = { ...entry.state, status: 'error', error: (error as Error).message }
      }
      await client.close().catch(() => {})
      if (this.servers.get(spec.name) !== entry) return
    }
    this.opts.onChange?.()
  }

  private wrap(server: string, client: Client, tool: { name: string; description?: string; inputSchema: Record<string, unknown>; outputSchema?: Record<string, unknown>; annotations?: { readOnlyHint?: boolean } }): Tool {
    return {
      name: mcpToolName(server, tool.name, this.taken),
      description: `[MCP ${server}] ${tool.description ?? tool.name}`.slice(0, 1024),
      schema: z.record(z.string(), z.unknown()),
      jsonSchema: tool.inputSchema,
      ...(tool.outputSchema ? { outputJsonSchema: tool.outputSchema } : {}),
      kind: 'mcp',
      programmaticSafe: tool.annotations?.readOnlyHint === true,
      target: (input) => {
        const text = JSON.stringify(input)
        return text.length > 80 ? `${text.slice(0, 77)}…` : text
      },
      async run(input, ctx) {
        try {
          const result = (await client.callTool({ name: tool.name, arguments: input as Record<string, unknown> }, undefined, { signal: ctx.signal })) as {
            content?: { type: string; text?: string }[]
            isError?: boolean
          }
          const output = (result.content ?? []).map((c) => (c.type === 'text' ? (c.text ?? '') : `[${c.type}]`)).join('\n') || '(empty)'
          return {
            output:
              output.length > MCP_OUTPUT_MAX_CHARS
                ? `${output.slice(0, MCP_OUTPUT_MAX_CHARS)}\n… [truncated at ${MCP_OUTPUT_MAX_CHARS} characters; narrow the MCP request if possible]`
                : output,
            isError: !!result.isError,
          }
        } catch (error) {
          return { output: `Server MCP ${server} error: ${(error as Error).message}`, isError: true }
        }
      },
    }
  }

  async remove(name: string): Promise<void> {
    const entry = this.servers.get(name)
    if (!entry) return
    this.servers.delete(name)
    for (const t of entry.tools) this.taken.delete(t.name)
    if (entry.tools.length) this.opts.onToolsRemoved?.(entry.tools.map((t) => t.name))
    await entry.client?.close().catch(() => {})
    this.opts.onChange?.()
  }

  tools(): Tool[] {
    return [...this.servers.values()]
      .flatMap((s) => s.tools)
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  states(): McpServerState[] {
    return [...this.servers.values()].map((s) => s.state)
  }

  async stop(): Promise<void> {
    await Promise.all([...this.servers.keys()].map((name) => this.remove(name)))
  }
}
