import { execFile } from 'node:child_process'
import { statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { glob as nativeGlob } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import { z } from 'zod'
import { collectUntilAbort } from '../abort'
import { ignorePatterns } from './ignore'
import { normalizeGlobPath, validateGlobPattern } from './globSafety'
import { resolvePath } from './paths'
import { defineTool } from './types'
import { t } from '../i18n'

const MAX_MATCHES = 200
const MAX_OUTPUT_CHARS = 24_000

export interface GrepOptions {
  root: string
  projectRoot?: string
  glob?: string
  ignoreCase?: boolean
  literal?: boolean
  context?: number
  outputMode?: 'content' | 'files_with_matches' | 'count'
  signal?: AbortSignal
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function isSingleFile(p: string): boolean {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

export async function grepJs(pattern: string, opts: GrepOptions): Promise<string[]> {
  const source = opts.literal ? escapeRegExp(pattern) : pattern
  const regex = new RegExp(source, opts.ignoreCase ? 'i' : '')
  const single = isSingleFile(opts.root)
  const files: string[] = []
  if (single) {
    files.push(basename(opts.root))
  } else {
    const finished = await collectUntilAbort(
      nativeGlob(opts.glob ?? '**/*', { cwd: opts.root, exclude: ignorePatterns(opts.root, opts.projectRoot) }),
      opts.signal,
      (file) => files.push(normalizeGlobPath(file)),
    )
    if (!finished) return []
  }
  const baseDir = single ? dirname(opts.root) : opts.root
  const ctxLines = Math.max(0, Math.min(10, Math.floor(opts.context ?? 0)))
  const mode = opts.outputMode ?? 'content'
  const out: string[] = []
  for (const file of files.sort()) {
    if (opts.signal?.aborted) break
    let text: string
    try {
      const buffer = await readFile(resolvePath(baseDir, file))
      if (buffer.subarray(0, 8000).includes(0)) continue
      text = buffer.toString('utf8')
    } catch {
      continue
    }
    const lines = text.split(/\r?\n/)
    let fileMatches = 0
    for (let i = 0; i < lines.length && out.length < MAX_MATCHES; i++) {
      if (regex.test(lines[i])) {
        fileMatches++
        if (mode === 'files_with_matches') {
          out.push(file)
          break
        }
        if (mode === 'content') {
          const from = Math.max(0, i - ctxLines)
          const to = Math.min(lines.length - 1, i + ctxLines)
          for (let j = from; j <= to && out.length < MAX_MATCHES; j++) {
            const sep = j === i ? ':' : '-'
            out.push(`${file}${sep}${j + 1}${sep}${lines[j].slice(0, 300)}`)
          }
        }
      }
    }
    if (mode === 'count' && fileMatches > 0) out.push(`${file}:${fileMatches}`)
    if (out.length >= MAX_MATCHES) break
  }
  return out
}

function grepRg(pattern: string, opts: GrepOptions): Promise<string[] | undefined> {
  const single = isSingleFile(opts.root)
  const cwd = single ? dirname(opts.root) : opts.root
  const target = single ? basename(opts.root) : '.'
  const mode = opts.outputMode ?? 'content'
  const args = ['--color', 'never']
  if (mode === 'files_with_matches') {
    args.push('--files-with-matches')
  } else if (mode === 'count') {
    args.push('--count')
  } else {
    args.push('--line-number', '--no-heading', '--max-columns', '300')
    if (opts.context && opts.context > 0) args.push('-C', String(Math.min(10, Math.floor(opts.context))))
  }
  if (opts.literal) args.push('-F')
  if (opts.ignoreCase) args.push('-i')
  if (opts.glob && !single) args.push('-g', opts.glob)
  args.push('-e', pattern, target)
  return new Promise((resolve) => {
    execFile('rg', args, { cwd, maxBuffer: 10 * 1024 * 1024, signal: opts.signal }, (error, stdout) => {
      if (opts.signal?.aborted) return resolve([]) // the child was killed; do not fall back to the slow JS search
      const code = (error as NodeJS.ErrnoException | null)?.code
      if (code === 'ENOENT') return resolve(undefined)
      if (error && (error as { code?: unknown }).code !== 1) return resolve(undefined)
      resolve(
        stdout
          .split(/\r?\n/)
          .filter(Boolean)
          .map((l) => l.replace(/^\.[\\/]/, '').replace(/\\/g, '/'))
          .slice(0, MAX_MATCHES),
      )
    })
  })
}

export const grepTool = defineTool({
  name: 'grep',
  description: 'Search file contents with a regular expression or literal text. Respects .gitignore. Returns path:line:text (max 200).',
  schema: z.object({
    pattern: z.string().describe('Regular expression or literal string'),
    path: z.string().optional().describe('File or directory to search, default project root'),
    glob: z.string().optional().describe('Only files matching this glob, e.g. "**/*.ts"'),
    ignore_case: z.boolean().optional(),
    literal: z.boolean().optional().describe('Treat pattern as literal text instead of regex'),
    context: z.number().int().min(0).max(10).optional().describe('Number of context lines before and after each match'),
    output_mode: z.enum(['content', 'files_with_matches', 'count']).optional().describe('Output format, default content'),
  }),
  kind: 'read',
  target: (input) => (input.path ? `${input.pattern} ${input.path}` : input.pattern),
  async run(input, ctx) {
    if (input.glob) {
      const invalid = validateGlobPattern(input.glob)
      if (invalid) return { output: invalid, isError: true }
    }
    const opts: GrepOptions = {
      root: resolvePath(ctx.cwd, input.path ?? '.'),
      projectRoot: ctx.cwd,
      glob: input.glob,
      ignoreCase: input.ignore_case,
      literal: input.literal,
      context: input.context,
      outputMode: input.output_mode,
      signal: ctx.signal,
    }
    if (!input.literal) {
      try {
        new RegExp(input.pattern)
      } catch (error) {
        return { output: `Invalid regex: ${(error as Error).message}`, isError: true }
      }
    }
    const matches = (await grepRg(input.pattern, opts)) ?? (await grepJs(input.pattern, opts))
    if (ctx.signal.aborted) return { output: 'Cancelled by the user.', isError: true }
    if (!matches.length) return { output: 'No matches.' }
    const shown: string[] = []
    let size = 0
    for (const match of matches) {
      const extra = match.length + (shown.length ? 1 : 0)
      if (shown.length && size + extra > MAX_OUTPUT_CHARS) break
      shown.push(match)
      size += extra
      if (size >= MAX_OUTPUT_CHARS) break
    }
    const omitted = matches.length - shown.length
    const suffix = omitted > 0 ? `\n… ${omitted} more matches omitted (narrow pattern/path/glob)` : ''
    return { output: shown.join('\n') + suffix, display: t('{n} results', { n: matches.length }) }
  },
})
