import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'
import { diffLines, formatDiff } from '../diff'
import { errorCode, isFileModifiedSinceRead, recordFileMtime, resolvePath } from './paths'
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
    if (existsSync(abs) && !ctx.readFiles.has(abs)) return `${input.path} already exists. Read it with read before overwriting it.`
    // Same rule as edit: a file that changed after the read must not be overwritten with
    // stale content (a formatter, a git checkout or another agent may have rewritten it).
    if (isFileModifiedSinceRead(ctx.readFiles, abs)) return `${input.path} has been modified since it was last read. Read it again before overwriting it.`
    return undefined
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
    if (isFileModifiedSinceRead(ctx.readFiles, abs)) {
      return { output: `${input.path} has been modified since it was last read. Read it again before overwriting it.`, isError: true }
    }
    try {
      await ctx.checkpoint?.(abs)
      await mkdir(dirname(abs), { recursive: true })
      await writeFile(abs, input.content)
    } catch (error) {
      return { output: `Failed to write ${input.path}: ${errorCode(error)}`, isError: true }
    }
    recordFileMtime(ctx.readFiles, abs)
    const lines = input.content.split('\n').length
    return { output: `Wrote ${input.path} (${lines} lines).`, display: t('{lines} lines written', { lines }) }
  },
})
