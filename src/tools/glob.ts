import { glob as nativeGlob } from 'node:fs/promises'
import { z } from 'zod'
import { ignorePatterns } from './ignore'
import { normalizeGlobPath, validateGlobPattern } from './globSafety'
import { resolvePath } from './paths'
import { defineTool } from './types'

const MAX_OUTPUT_CHARS = 24_000

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
    const invalid = validateGlobPattern(input.pattern)
    if (invalid) return { output: invalid, isError: true }
    const root = resolvePath(ctx.cwd, input.path ?? '.')
    const files: string[] = []
    for await (const file of nativeGlob(input.pattern, { cwd: root, exclude: ignorePatterns(root) })) {
      files.push(normalizeGlobPath(file))
    }
    files.sort()
    if (!files.length) return { output: 'No matching files.' }
    const first = files.slice(0, 500)
    const shown: string[] = []
    let size = 0
    for (const file of first) {
      const extra = file.length + (shown.length ? 1 : 0)
      if (shown.length && size + extra > MAX_OUTPUT_CHARS) break
      shown.push(file)
      size += extra
      if (size >= MAX_OUTPUT_CHARS) break
    }
    const omitted = files.length - shown.length
    const more = omitted > 0 ? `\n… ${omitted} more files omitted (narrow pattern/path)` : ''
    return { output: shown.join('\n') + more, display: `${files.length} file` }
  },
})
