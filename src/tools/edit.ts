import { readFile, writeFile } from 'node:fs/promises'
import { z } from 'zod'
import { diffLines, formatDiff } from '../diff'
import { errorCode, resolvePath } from './paths'
import { defineTool, type ToolResult } from './types'

const schema = z.object({
  path: z.string().describe('File path, relative to the project or absolute'),
  old_string: z.string().describe('Exact text to replace; must be unique unless replace_all'),
  new_string: z.string().describe('Replacement text'),
  replace_all: z.boolean().optional().describe('Replace every occurrence'),
})
type EditInput = z.infer<typeof schema>

function countOccurrences(haystack: string, needle: string): number {
  let count = 0
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + needle.length)) count++
  return count
}

/** Returns the new content, or an error result. */
function applyEdit(content: string, input: EditInput): string | ToolResult {
  const eol = content.includes('\r\n') ? '\r\n' : '\n'
  const toEol = (s: string) => s.replace(/\r?\n/g, eol)
  const oldText = toEol(input.old_string)
  const newText = toEol(input.new_string)
  if (oldText === newText) return { output: 'old_string dan new_string sama; tidak ada perubahan.', isError: true }
  const count = oldText ? countOccurrences(content, oldText) : 0
  if (count === 0) return { output: `old_string tidak ditemukan di ${input.path}. Baca ulang file-nya.`, isError: true }
  if (count > 1 && !input.replace_all) {
    return {
      output: `old_string muncul ${count} kali di ${input.path}. Tambah konteks agar unik, atau pakai replace_all.`,
      isError: true,
    }
  }
  return input.replace_all ? content.split(oldText).join(newText) : content.replace(oldText, () => newText)
}

export const editTool = defineTool({
  name: 'edit',
  description:
    'Replace exact text in a file. The file must have been read first. old_string must match exactly (including indentation) and be unique unless replace_all is true.',
  schema,
  kind: 'edit',
  target: (input) => input.path,
  async preview(input, ctx) {
    const abs = resolvePath(ctx.cwd, input.path)
    const content = await readFile(abs, 'utf8')
    const next = applyEdit(content, input)
    return typeof next === 'string' ? formatDiff(diffLines(content, next)) : undefined
  },
  async run(input, ctx) {
    const abs = resolvePath(ctx.cwd, input.path)
    if (!ctx.readFiles.has(abs)) {
      return { output: `Baca ${input.path} dulu dengan read sebelum mengedit.`, isError: true }
    }
    let content: string
    try {
      content = await readFile(abs, 'utf8')
    } catch (error) {
      return { output: `Tidak bisa membaca ${input.path}: ${errorCode(error)}`, isError: true }
    }
    const next = applyEdit(content, input)
    if (typeof next !== 'string') return next
    await writeFile(abs, next)
    return { output: `Mengedit ${input.path}.`, display: formatDiff(diffLines(content, next)) }
  },
})
