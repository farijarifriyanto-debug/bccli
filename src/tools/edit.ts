import { readFile, writeFile } from 'node:fs/promises'
import { z } from 'zod'
import { diffLines, formatDiff } from '../diff'
import { errorCode, isFileModifiedSinceRead, recordFileMtime, resolvePath } from './paths'
import { defineTool, type ToolResult } from './types'

const editEntrySchema = z.object({
  old_string: z.string().describe('Exact text to replace; must be unique unless replace_all'),
  new_string: z.string().describe('Replacement text'),
  replace_all: z.boolean().optional().describe('Replace every occurrence'),
})

const schema = z.object({
  path: z.string().describe('File path, relative to the project or absolute'),
  old_string: z.string().optional().describe('Exact text to replace; must be unique unless replace_all'),
  new_string: z.string().optional().describe('Replacement text'),
  replace_all: z.boolean().optional().describe('Replace every occurrence'),
  edits: z.array(editEntrySchema).optional().describe('Optional list of sequential edits to apply atomically to the same file'),
})
type EditInput = z.infer<typeof schema>
type SingleEdit = z.infer<typeof editEntrySchema>

function countOccurrences(haystack: string, needle: string): number {
  let count = 0
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + needle.length)) count++
  return count
}

function normalizeTypographic(s: string): string {
  return s
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\u00A0/g, ' ')
}

function stripReadLinePrefixes(s: string): string {
  const lines = s.split(/\r?\n/)
  if (lines.every((l) => !l.trim() || /^\s*\d+\t/.test(l))) {
    return lines.map((l) => l.replace(/^\s*\d+\t/, '')).join('\n')
  }
  return s
}

function matchByNormalizedLines(content: string, oldText: string, newText: string, replaceAll?: boolean): { count: number; result?: string } {
  const eol = content.includes('\r\n') ? '\r\n' : '\n'
  const fileLines = content.split(/\r?\n/)
  const oldLines = stripReadLinePrefixes(oldText).split(/\r?\n/)
  if (!oldLines.length) return { count: 0 }
  const normLine = (l: string) => normalizeTypographic(l).trimEnd()
  const normOld = oldLines.map(normLine)
  const matches: number[] = []
  for (let i = 0; i + oldLines.length <= fileLines.length; i++) {
    let ok = true
    for (let j = 0; j < oldLines.length; j++) {
      if (normLine(fileLines[i + j]) !== normOld[j]) {
        ok = false
        break
      }
    }
    if (ok) {
      matches.push(i)
      if (replaceAll) i += oldLines.length - 1
    }
  }
  if (matches.length === 0) return { count: 0 }
  if (matches.length > 1 && !replaceAll) return { count: matches.length }
  const replacementLines = stripReadLinePrefixes(newText).split(/\r?\n/)
  const outLines = [...fileLines]
  for (let m = matches.length - 1; m >= 0; m--) {
    outLines.splice(matches[m], oldLines.length, ...replacementLines)
  }
  return { count: matches.length, result: outLines.join(eol) }
}

/** Returns the new content for a single edit, or an error result. */
function applySingleEdit(content: string, path: string, input: SingleEdit): string | ToolResult {
  if (input.old_string === input.new_string) {
    return { output: 'old_string and new_string are identical; nothing to change.', isError: true }
  }
  const eol = content.includes('\r\n') ? '\r\n' : '\n'
  const toEol = (s: string) => s.replace(/\r?\n/g, eol)
  const strippedOld = stripReadLinePrefixes(input.old_string)
  const strippedNew = stripReadLinePrefixes(input.new_string)
  const attempts: [string, string][] = [[input.old_string, input.new_string]]
  if (toEol(input.old_string) !== input.old_string) attempts.push([toEol(input.old_string), toEol(input.new_string)])
  if (strippedOld !== input.old_string) {
    attempts.push([strippedOld, strippedNew], [toEol(strippedOld), toEol(strippedNew)])
  }
  for (const [oldText, newText] of attempts) {
    const count = oldText ? countOccurrences(content, oldText) : 0
    if (count === 0) continue
    if (count > 1 && !input.replace_all) {
      return {
        output: `old_string appears ${count} times in ${path}. Add more context to make it unique, or use replace_all.`,
        isError: true,
      }
    }
    return input.replace_all ? content.split(oldText).join(newText) : content.replace(oldText, () => newText)
  }
  const fuzzy = matchByNormalizedLines(content, input.old_string, input.new_string, input.replace_all)
  if (fuzzy.count > 1 && !input.replace_all) {
    return {
      output: `old_string appears ${fuzzy.count} times in ${path}. Add more context to make it unique, or use replace_all.`,
      isError: true,
    }
  }
  if (fuzzy.count > 0 && fuzzy.result !== undefined) return fuzzy.result
  return { output: `old_string not found in ${path}. Re-read the file.`, isError: true }
}

function applyEdit(content: string, input: EditInput): string | ToolResult {
  const list: SingleEdit[] = input.edits?.length
    ? input.edits
    : input.old_string !== undefined && input.new_string !== undefined
      ? [{ old_string: input.old_string, new_string: input.new_string, replace_all: input.replace_all }]
      : []
  if (!list.length) return { output: 'Provide old_string and new_string (or edits array).', isError: true }
  let current = content
  for (const item of list) {
    const next = applySingleEdit(current, input.path, item)
    if (typeof next !== 'string') return next
    current = next
  }
  return current
}

export const editTool = defineTool({
  name: 'edit',
  description:
    'Replace exact text in a file. The file must have been read first. old_string must match exactly (including indentation) and be unique unless replace_all is true.',
  schema,
  kind: 'edit',
  target: (input) => input.path,
  async validate(input, ctx) {
    const abs = resolvePath(ctx.cwd, input.path)
    if (!ctx.readFiles.has(abs)) return `Read ${input.path} with read before editing it.`
    if (isFileModifiedSinceRead(ctx.readFiles, abs)) {
      return `${input.path} has been modified since it was last read. Read it again before editing.`
    }
    let content: string
    try {
      content = await readFile(abs, 'utf8')
    } catch (error) {
      return `Cannot read ${input.path}: ${errorCode(error)}`
    }
    const next = applyEdit(content, input)
    return typeof next === 'string' ? undefined : next.output
  },
  async preview(input, ctx) {
    const abs = resolvePath(ctx.cwd, input.path)
    const content = await readFile(abs, 'utf8')
    const next = applyEdit(content, input)
    return typeof next === 'string' ? formatDiff(diffLines(content, next)) : undefined
  },
  async run(input, ctx) {
    const abs = resolvePath(ctx.cwd, input.path)
    if (!ctx.readFiles.has(abs)) {
      return { output: `Read ${input.path} with read before editing it.`, isError: true }
    }
    if (isFileModifiedSinceRead(ctx.readFiles, abs)) {
      return { output: `${input.path} has been modified since it was last read. Read it again before editing.`, isError: true }
    }
    let content: string
    try {
      content = await readFile(abs, 'utf8')
    } catch (error) {
      return { output: `Cannot read ${input.path}: ${errorCode(error)}`, isError: true }
    }
    const next = applyEdit(content, input)
    if (typeof next !== 'string') return next
    await ctx.checkpoint?.(abs)
    await writeFile(abs, next)
    recordFileMtime(ctx.readFiles, abs)
    return { output: `Edited ${input.path}.`, display: formatDiff(diffLines(content, next)) }
  },
})
