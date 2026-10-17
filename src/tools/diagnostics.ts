import { extname } from 'node:path'
import { z } from 'zod'
import { t } from '../i18n'
import { getDiagnostics, type LspServer } from '../lsp'
import { resolvePath } from './paths'
import { defineTool } from './types'

const SEVERITY: Record<number, string> = { 1: 'error', 2: 'warning', 3: 'info', 4: 'hint' }

const SCHEMA = z.object({ path: z.string().describe('File to check (absolute or relative to the working directory)') })

export function createDiagnosticsTool(servers: LspServer[]) {
  return defineTool({
    name: 'diagnostics',
    description:
      'Run the configured LSP server(s) on one file and return its diagnostics (errors/warnings). Configure servers under "lsp.servers" in ~/.bccli/config.json, e.g. { "extensions": [".ts"], "command": "typescript-language-server", "args": ["--stdio"] }.',
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
      const diags = await getDiagnostics({ server, cwd: ctx.cwd, file, timeoutMs: 15_000 })
      if (!diags.length) return { output: 'No diagnostics.' }
      const lines = diags.map((d) => `${input.path}:${d.line + 1}:${d.character + 1} ${SEVERITY[d.severity] ?? 'error'} ${d.message}`)
      return { output: lines.join('\n'), isError: diags.some((d) => d.severity === 1) }
    },
  })
}
