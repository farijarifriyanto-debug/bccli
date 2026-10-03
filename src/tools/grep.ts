import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { glob as nativeGlob } from 'node:fs/promises'
import { z } from 'zod'
import { ignorePatterns } from './ignore'
import { validateGlobPattern } from './globSafety'
import { resolvePath } from './paths'
import { defineTool } from './types'
import { t } from '../i18n'

const MAX_MATCHES = 200
const MAX_OUTPUT_CHARS = 24_000

export async function grepJs(pattern: string, opts: { root: string; glob?: string; ignoreCase?: boolean }): Promise<string[]> {
  const regex = new RegExp(pattern, opts.ignoreCase ? 'i' : '')
  const files: string[] = []
  for await (const file of nativeGlob(opts.glob ?? '**/*', { cwd: opts.root, exclude: ignorePatterns(opts.root) })) {
    files.push(file)
  }
  const out: string[] = []
  for (const file of files.sort()) {
    let text: string
    try {
      const buffer = await readFile(resolvePath(opts.root, file))
      if (buffer.subarray(0, 8000).includes(0)) continue
      text = buffer.toString('utf8')
    } catch {
      continue
    }
    const lines = text.split(/\r?\n/)
    for (let i = 0; i < lines.length && out.length < MAX_MATCHES; i++) {
      if (regex.test(lines[i])) out.push(`${file}:${i + 1}:${lines[i].slice(0, 300)}`)
    }
    if (out.length >= MAX_MATCHES) break
  }
  return out
}

function grepRg(pattern: string, opts: { root: string; glob?: string; ignoreCase?: boolean }): Promise<string[] | undefined> {
  const args = ['--line-number', '--no-heading', '--color', 'never', '--max-columns', '300', '-e', pattern]
  if (opts.ignoreCase) args.push('-i')
  if (opts.glob) args.push('-g', opts.glob)
  args.push('.')
  return new Promise((resolve) => {
    execFile('rg', args, { cwd: opts.root, maxBuffer: 10 * 1024 * 1024 }, (error, stdout) => {
      const code = (error as NodeJS.ErrnoException | null)?.code
      if (code === 'ENOENT') return resolve(undefined)
      if (error && (error as { code?: unknown }).code !== 1) return resolve(undefined)
      resolve(stdout.split('\n').filter(Boolean).map((l) => l.replace(/^\.\//, '')).slice(0, MAX_MATCHES))
    })
  })
}

export const grepTool = defineTool({
  name: 'grep',
  description: 'Search file contents with a regular expression. Respects .gitignore. Returns path:line:text (max 200).',
  schema: z.object({
    pattern: z.string().describe('Regular expression'),
    path: z.string().optional().describe('Directory to search, default project root'),
    glob: z.string().optional().describe('Only files matching this glob, e.g. "**/*.ts"'),
    ignore_case: z.boolean().optional(),
  }),
  kind: 'read',
  target: (input) => input.pattern,
  async run(input, ctx) {
    if (input.glob) {
      const invalid = validateGlobPattern(input.glob)
      if (invalid) return { output: invalid, isError: true }
    }
    const opts = { root: resolvePath(ctx.cwd, input.path ?? '.'), glob: input.glob, ignoreCase: input.ignore_case }
    try {
      new RegExp(input.pattern)
    } catch (error) {
      return { output: `Invalid regex: ${(error as Error).message}`, isError: true }
    }
    const matches = (await grepRg(input.pattern, opts)) ?? (await grepJs(input.pattern, opts))
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
