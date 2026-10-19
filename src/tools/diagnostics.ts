import { extname, relative } from 'node:path'
import { z } from 'zod'
import { t } from '../i18n'
import { createWarmLspClient, type LspServer, type WarmLspClient } from '../lsp'
import { resolvePath } from './paths'
import { defineTool } from './types'

const SEVERITY: Record<number, string> = { 1: 'error', 2: 'warning', 3: 'info', 4: 'hint' }

const SCHEMA = z.object({
  path: z.string().describe('File to check (absolute or relative to the working directory)'),
  action: z.enum(['diagnostics', 'hover', 'definition', 'references']).optional().describe('LSP query action, default diagnostics'),
  line: z.number().int().min(1).optional().describe('1-based line number for hover, definition, or references'),
  character: z.number().int().min(1).optional().describe('1-based column number for hover, definition, or references'),
})

export function createDiagnosticsTool(servers: LspServer[]) {
  const warmPool = new Map<string, WarmLspClient>()
  const clientFor = (server: LspServer, cwd: string): WarmLspClient => {
    const key = `${cwd}::${server.command}::${(server.args ?? []).join('\0')}`
    let client = warmPool.get(key)
    if (!client) {
      client = createWarmLspClient({ server, cwd, timeoutMs: 15_000 })
      warmPool.set(key, client)
    }
    return client
  }
  return defineTool({
    name: 'diagnostics',
    description:
      'Query the configured LSP server(s) on a file for diagnostics (errors/warnings), hover docs, definition, or references. Configure servers under "lsp.servers" in ~/.bccli/config.json, e.g. { "extensions": [".ts"], "command": "typescript-language-server", "args": ["--stdio"] }.',
    schema: SCHEMA,
    kind: 'read',
    target: (input: z.infer<typeof SCHEMA>) => input.path,
    async run(input: z.infer<typeof SCHEMA>, ctx) {
      const file = resolvePath(ctx.cwd, input.path)
      const ext = extname(file).toLowerCase()
      const server = servers.find((s) => s.extensions.includes(ext))
      if (!server) {
        return { output: t('No LSP server is configured for {ext} files.', { ext: ext || '(none)' }), isError: true }
      }
      const client = clientFor(server, ctx.cwd)
      const action = input.action ?? 'diagnostics'
      const line0 = Math.max(0, (input.line ?? 1) - 1)
      const char0 = Math.max(0, (input.character ?? 1) - 1)
      if (action === 'hover') {
        const text = await client.hover(file, line0, char0, 15_000)
        return { output: text || 'No hover information.' }
      }
      if (action === 'definition' || action === 'references') {
        const locs = action === 'definition' ? await client.definition(file, line0, char0, 15_000) : await client.references(file, line0, char0, 15_000)
        if (!locs.length) return { output: `No ${action} found.` }
        const formatted = locs.map((l) => {
          const rel = relative(ctx.cwd, l.path).replace(/\\/g, '/') || input.path
          return `${rel}:${l.line + 1}:${l.character + 1}`
        })
        return { output: formatted.join('\n') }
      }
      const diags = await client.diagnostics(file, 15_000)
      if (!diags.length) return { output: 'No diagnostics.' }
      const lines = diags.map((d) => `${input.path}:${d.line + 1}:${d.character + 1} ${SEVERITY[d.severity] ?? 'error'} ${d.message}`)
      return { output: lines.join('\n'), isError: diags.some((d) => d.severity === 1) }
    },
  })
}
