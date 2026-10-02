import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import { errorCode, resolvePath } from './paths'
import { defineTool } from './types'
import { t } from '../i18n'

const MAX_LINE = 2000
const MAX_OUTPUT_CHARS = 40_000

export const readTool = defineTool({
  name: 'read',
  description:
    'Read a text file. Returns numbered lines (default first 2000). Use offset/limit for large files. Always read a file before editing it.',
  schema: z.object({
    path: z.string().describe('File path, relative to the project or absolute'),
    offset: z.number().int().min(1).optional().describe('First line to read, 1-based'),
    limit: z.number().int().min(1).optional().describe('Number of lines, default 2000'),
  }),
  kind: 'read',
  target: (input) => input.path,
  async run(input, ctx) {
    const abs = resolvePath(ctx.cwd, input.path)
    let buffer: Buffer
    try {
      buffer = await readFile(abs)
    } catch (error) {
      return { output: `Cannot read ${input.path}: ${errorCode(error)}`, isError: true }
    }
    if (buffer.subarray(0, 8000).includes(0)) {
      return { output: `${input.path} is a binary file; not read.`, isError: true }
    }
    const lines = buffer.toString('utf8').split(/\r?\n/)
    const start = (input.offset ?? 1) - 1
    const limit = input.limit ?? 2000
    const requested = lines.slice(start, start + limit)
    const shown: string[] = []
    let size = 0
    for (let i = 0; i < requested.length; i++) {
      const line = requested[i]
      const text = line.length > MAX_LINE ? `${line.slice(0, MAX_LINE)}… [line truncated]` : line
      const rendered = `${String(start + i + 1).padStart(6)}\t${text}`
      const extra = rendered.length + (shown.length ? 1 : 0)
      if (shown.length && size + extra > MAX_OUTPUT_CHARS) break
      shown.push(rendered)
      size += extra
      if (size >= MAX_OUTPUT_CHARS) break
    }
    const body = shown.join('\n')
    const remaining = lines.length - start - shown.length
    const tokenBudgetHit = shown.length < requested.length
    const nextOffset = start + shown.length + 1
    ctx.readFiles.add(abs)
    return {
      output:
        remaining > 0
          ? tokenBudgetHit
            ? `${body}\n… ${remaining} more lines (token budget reached; continue with offset=${nextOffset})`
            : `${body}\n… ${remaining} more lines (use offset)`
          : body,
      display: t('{n} lines', { n: shown.length }),
    }
  },
})
