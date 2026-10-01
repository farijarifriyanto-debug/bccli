import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'
import { diffLines, formatDiff } from '../diff'
import { errorCode, resolvePath } from './paths'
import { defineTool } from './types'
import { t } from '../i18n'

export const writeTool = defineTool({
  name: 'write',
  description: 'Create or overwrite a file with the given content. Read an existing file first. Prefer edit for changes.',
  schema: z.object({
    path: z.string().describe('File path, relative to the project or absolute'),
    content: z.string().describe('Full new file content'),
  }),
  kind: 'edit',
  target: (input) => input.path,
  async validate(input, ctx) {
    const abs = resolvePath(ctx.cwd, input.path)
    return existsSync(abs) && !ctx.readFiles.has(abs) ? `${input.path} already exists. Read it with read before overwriting it.` : undefined
  },
  async preview(input, ctx) {
    const abs = resolvePath(ctx.cwd, input.path)
    const old = existsSync(abs) ? await readFile(abs, 'utf8') : ''
    return formatDiff(diffLines(old, input.content))
  },
  async run(input, ctx) {
    const abs = resolvePath(ctx.cwd, input.path)
    if (existsSync(abs) && !ctx.readFiles.has(abs)) {
      return { output: `${input.path} already exists. Read it with read before overwriting it.`, isError: true }
    }
    try {
      await ctx.checkpoint?.(abs)
      await mkdir(dirname(abs), { recursive: true })
      await writeFile(abs, input.content)
    } catch (error) {
      return { output: `Failed to write ${input.path}: ${errorCode(error)}`, isError: true }
    }
    ctx.readFiles.add(abs)
    const lines = input.content.split('\n').length
    return { output: `Wrote ${input.path} (${lines} lines).`, display: t('{lines} lines written', { lines }) }
  },
})
