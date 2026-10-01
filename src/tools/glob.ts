import fg from 'fast-glob'
import { z } from 'zod'
import { ignorePatterns } from './ignore'
import { resolvePath } from './paths'
import { defineTool } from './types'

export const globTool = defineTool({
  name: 'glob',
  description: 'Find files by glob pattern, e.g. "src/**/*.ts". Respects .gitignore. Max 500 results.',
  schema: z.object({
    pattern: z.string().describe('Glob pattern'),
    path: z.string().optional().describe('Base directory, default project root'),
  }),
  kind: 'read',
  target: (input) => input.pattern,
  async run(input, ctx) {
    const root = resolvePath(ctx.cwd, input.path ?? '.')
    const files = (await fg(input.pattern, { cwd: root, ignore: ignorePatterns(root), onlyFiles: true, dot: true })).sort()
    if (!files.length) return { output: 'No matching files.' }
    const shown = files.slice(0, 500)
    const more = files.length > shown.length ? `\n… ${files.length - shown.length} more files` : ''
    return { output: shown.join('\n') + more, display: `${files.length} file` }
  },
})
