import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import { errorCode, resolvePath } from './paths'
import { defineTool, type ToolContext, type ToolResult } from './types'
import { t } from '../i18n'

const MAX_LINE = 2000
const MAX_OUTPUT_CHARS = 40_000
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024

const IMAGE_HEADERS: { mediaType: string; match: (head: Buffer) => boolean }[] = [
  {
    mediaType: 'image/png',
    match: (h) => h.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  },
  { mediaType: 'image/jpeg', match: (h) => h[0] === 0xff && h[1] === 0xd8 && h[2] === 0xff },
  { mediaType: 'image/gif', match: (h) => h.subarray(0, 6).toString('ascii').startsWith('GIF8') },
  {
    mediaType: 'image/webp',
    match: (h) => h.subarray(0, 4).toString('ascii') === 'RIFF' && h.subarray(8, 12).toString('ascii') === 'WEBP',
  },
]

const MEDIA_LABEL: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpeg',
  'image/gif': 'gif',
  'image/webp': 'webp',
}

function imageMediaType(buffer: Buffer): string | undefined {
  return IMAGE_HEADERS.find((entry) => entry.match(buffer))?.mediaType
}

export interface ReadToolOptions {
  /** Attach images to the conversation as vision parts instead of refusing binary files. Default true. */
  vision?: boolean
}

const schema = z.object({
  path: z.string().describe('File path, relative to the project or absolute'),
  offset: z.number().int().min(1).optional().describe('First line to read, 1-based'),
  limit: z.number().int().min(1).optional().describe('Number of lines, default 2000'),
})

type ReadInput = z.infer<typeof schema>

async function readImageResult(input: ReadInput, buffer: Buffer, mediaType: string): Promise<ToolResult> {
  if (buffer.length > MAX_IMAGE_BYTES) {
    return {
      output: `Cannot attach ${input.path}: image is ${(buffer.length / (1024 * 1024)).toFixed(1)} MB (limit 4 MB).`,
      isError: true,
    }
  }
  const label = MEDIA_LABEL[mediaType] ?? mediaType
  return {
    output: `[image attached] ${input.path} (${label}, ${(buffer.length / 1024).toFixed(1)} KB).`,
    display: `${input.path} · image`,
    images: [{ mediaType, data: buffer.toString('base64'), path: input.path }],
  }
}

async function readTextResult(input: ReadInput, buffer: Buffer): Promise<ToolResult> {
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
  return {
    output:
      remaining > 0
        ? tokenBudgetHit
          ? `${body}\n… ${remaining} more lines (token budget reached; continue with offset=${nextOffset})`
          : `${body}\n… ${remaining} more lines (use offset)`
        : body,
    display: t('{n} lines', { n: shown.length }),
  }
}

export function createReadTool(options: ReadToolOptions = {}) {
  const vision = options.vision !== false
  return defineTool({
    name: 'read',
    description: vision
      ? 'Read a text file, or an image (png/jpeg/gif/webp) which is attached for the model to see. Returns numbered lines (default first 2000). Use offset/limit for large files. Always read a file before editing it.'
      : 'Read a text file. Returns numbered lines (default first 2000). Use offset/limit for large files. Always read a file before editing it.',
    schema,
    kind: 'read',
    target: (input: ReadInput) => input.path,
    async run(input: ReadInput, ctx: ToolContext): Promise<ToolResult> {
      const abs = resolvePath(ctx.cwd, input.path)
      let buffer: Buffer
      try {
        buffer = await readFile(abs)
      } catch (error) {
        return { output: `Cannot read ${input.path}: ${errorCode(error)}`, isError: true }
      }
      const mediaType = vision ? imageMediaType(buffer) : undefined
      if (mediaType) {
        ctx.readFiles.add(abs)
        return readImageResult(input, buffer, mediaType)
      }
      if (buffer.subarray(0, 8000).includes(0)) {
        return { output: `${input.path} is a binary file; not read.`, isError: true }
      }
      ctx.readFiles.add(abs)
      return readTextResult(input, buffer)
    },
  })
}

export const readTool = createReadTool({ vision: true })
