import { spawn } from 'node:child_process'
import { t } from './i18n'

export interface PrCliArgs {
  subArgs: string[]
  cwd: string
  /** Set only when the user asked for `bccli pr … --allow-all`. */
  allowAll?: boolean
  repo?: string
  model?: string
  reasoning?: string
  permissionMode?: string
  allowedTools?: string[]
}

export interface PrDeps {
  out(line: string): void
  err?(line: string): void
  /** gh argv runner (no shell). Defaults to `gh` on PATH. */
  gh?(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }>
  /** Run the agent task after checkout (injectable for tests). */
  runTask?(opts: {
    prompt?: string
    allowAll: boolean
    cwd: string
    model?: string
    reasoning?: string
    permissionMode?: string
    allowedTools?: string[]
  }): Promise<number>
}

function defaultGh(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('gh', argv, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (d) => {
      stdout += d
    })
    child.stderr?.on('data', (d) => {
      stderr += d
    })
    child.on('error', (e) => resolve({ code: 127, stdout, stderr: String(e) }))
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }))
  })
}

/** argv for the child running the PR task; `--allow-all` only when the user asked for it. */
export function prTaskArgv(
  entry: string,
  opts: {
    prompt?: string
    allowAll?: boolean
    model?: string
    reasoning?: string
    permissionMode?: string
    allowedTools?: string[]
  },
): string[] {
  return [
    entry,
    ...(opts.prompt ? ['-p', opts.prompt] : []),
    ...(opts.model ? ['-m', opts.model] : []),
    ...(opts.reasoning ? ['--reasoning', opts.reasoning] : []),
    ...(opts.permissionMode ? ['--permission-mode', opts.permissionMode] : []),
    ...(opts.allowedTools?.length ? ['--allowed-tools', opts.allowedTools.join(',')] : []),
    ...(opts.allowAll ? ['--allow-all'] : []),
  ]
}

async function defaultRunTask(opts: {
  prompt?: string
  allowAll: boolean
  cwd: string
  model?: string
  reasoning?: string
  permissionMode?: string
  allowedTools?: string[]
}): Promise<number> {
  // process.argv[1] is the actual entry being executed (dist/cli.js via the npm
  // shim); import.meta.url points at a tsup chunk, so ../cli.js would be wrong.
  const entry = process.argv[1]
  if (!entry) return 1
  return new Promise((resolve) => {
    const child = spawn(process.execPath, prTaskArgv(entry, opts), {
      shell: false,
      stdio: 'inherit',
      cwd: opts.cwd,
    })
    child.on('error', () => resolve(1))
    child.on('close', (code) => resolve(code ?? 1))
  })
}

/**
 * `bccli pr <number> [--repo owner/name] [task]` — check out a GitHub PR
 * with `gh pr checkout`, then run an optional task on the checked-out branch.
 * Read-only: never pushes, merges, or comments.
 */
export async function runPrCommand(args: PrCliArgs, deps: PrDeps): Promise<number> {
  const rest = [...args.subArgs]
  let repo: string | undefined = args.repo
  const words: string[] = []
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--repo') {
      repo = rest[++i]
      continue
    }
    words.push(rest[i])
  }
  const number = words.shift()
  if (!number || !/^\d+$/.test(number)) {
    deps.err?.(t('usage: bccli pr <number> [--repo owner/name] [task]'))
    return 1
  }
  const task = words.length ? words.join(' ') : undefined
  const gh = deps.gh ?? defaultGh
  const checkoutArgv = ['pr', 'checkout', number, ...(repo ? ['--repo', repo] : [])]
  let res: { code: number; stdout: string; stderr: string }
  try {
    res = await gh(checkoutArgv)
  } catch (e) {
    deps.err?.(t('gh is not available ({error}); install GitHub CLI first', { error: String(e) }))
    return 1
  }
  if (res.code !== 0) {
    deps.err?.(t('gh pr checkout {n} failed (exit {code})', { n: number, code: String(res.code) }))
    return 1
  }
  deps.out(t('checked out PR #{n}', { n: number }))
  const runTask = deps.runTask ?? defaultRunTask
  const allowAll = args.allowAll === true
  if (allowAll) deps.err?.(t('--allow-all: the PR task runs every tool without asking'))
  return runTask({
    prompt: task,
    allowAll,
    cwd: args.cwd,
    ...(args.model ? { model: args.model } : {}),
    ...(args.reasoning ? { reasoning: args.reasoning } : {}),
    ...(args.permissionMode ? { permissionMode: args.permissionMode } : {}),
    ...(args.allowedTools?.length ? { allowedTools: args.allowedTools } : {}),
  })
}
