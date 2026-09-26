import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import { errorCode, resolvePath } from './paths'
import { defineTool } from './types'

const MAX_LINE = 2000

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
      return { output: `Tidak bisa membaca ${input.path}: ${errorCode(error)}`, isError: true }
    }
    if (buffer.subarray(0, 8000).includes(0)) {
      return { output: `${input.path} adalah file biner, tidak dibaca.`, isError: true }
    }
    const lines = buffer.toString('utf8').split(/\r?\n/)
    const start = (input.offset ?? 1) - 1
    const limit = input.limit ?? 2000
    const slice = lines.slice(start, start + limit)
    const body = slice
      .map((line, i) => {
        const text = line.length > MAX_LINE ? `${line.slice(0, MAX_LINE)}… [baris dipotong]` : line
        return `${String(start + i + 1).padStart(6)}\t${text}`
      })
      .join('\n')
    const remaining = lines.length - start - slice.length
    ctx.readFiles.add(abs)
    return {
      output: remaining > 0 ? `${body}\n… ${remaining} baris lagi (pakai offset)` : body,
      display: `${slice.length} baris`,
    }
  },
})
