import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import fg from 'fast-glob'
import { z } from 'zod'
import { ignorePatterns } from './ignore'
import { resolvePath } from './paths'
import { defineTool } from './types'

const MAX_MATCHES = 200

export async function grepJs(pattern: string, opts: { root: string; glob?: string; ignoreCase?: boolean }): Promise<string[]> {
  const regex = new RegExp(pattern, opts.ignoreCase ? 'i' : '')
  const files = await fg(opts.glob ?? '**/*', { cwd: opts.root, ignore: ignorePatterns(opts.root), onlyFiles: true, dot: true })
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
    const opts = { root: resolvePath(ctx.cwd, input.path ?? '.'), glob: input.glob, ignoreCase: input.ignore_case }
    try {
      new RegExp(input.pattern)
    } catch (error) {
      return { output: `Regex tidak valid: ${(error as Error).message}`, isError: true }
    }
    const matches = (await grepRg(input.pattern, opts)) ?? (await grepJs(input.pattern, opts))
    if (!matches.length) return { output: 'Tidak ada yang cocok.' }
    return { output: matches.join('\n'), display: `${matches.length} hasil` }
  },
})
