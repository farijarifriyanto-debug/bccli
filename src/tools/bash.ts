import { spawn } from 'node:child_process'
import { z } from 'zod'
import { defineTool } from './types'

const HALF = 15_000

type Spawn = typeof spawn

/** Kill a command and everything it started. Never throws (e.g. taskkill missing on Windows). */
export function killProcessTree(pid: number, platform: NodeJS.Platform = process.platform, spawnFn: Spawn = spawn): void {
  if (platform === 'win32') {
    const killer = spawnFn('taskkill', ['/pid', String(pid), '/T', '/F'])
    killer.on('error', () => {
      try {
        process.kill(pid)
      } catch {
        // already gone
      }
    })
    return
  }
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // already gone
    }
  }
}

// Commands run detached in their own process group, so Ctrl+C on bccli would leave them running.
const active = new Set<() => void>()
let exitHookInstalled = false

export function killAllCommands(): void {
  for (const kill of active) kill()
}

export interface CommandResult {
  output: string
  exitCode: number | null
  timedOut: boolean
  aborted: boolean
}

export function runCommand(
  command: string,
  opts: { cwd: string; timeoutMs: number; signal: AbortSignal },
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd: opts.cwd,
      shell: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    if (!exitHookInstalled) {
      process.on('exit', killAllCommands)
      exitHookInstalled = true
    }
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    let head = ''
    let tail = ''
    let dropped = 0
    let timedOut = false
    let aborted = false
    const onData = (data: string) => {
      let s = data
      if (head.length < HALF) {
        const take = s.slice(0, HALF - head.length)
        head += take
        s = s.slice(take.length)
      }
      if (s) {
        tail += s
        if (tail.length > HALF) {
          dropped += tail.length - HALF
          tail = tail.slice(-HALF)
        }
      }
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    const kill = () => {
      if (child.pid !== undefined) killProcessTree(child.pid)
    }
    const killAsAborted = () => {
      aborted = true
      kill()
    }
    active.add(killAsAborted)
    const timer = setTimeout(() => {
      timedOut = true
      kill()
    }, opts.timeoutMs)
    const onAbort = () => {
      aborted = true
      kill()
    }
    if (opts.signal.aborted) onAbort()
    opts.signal.addEventListener('abort', onAbort, { once: true })
    const finish = (exitCode: number | null, extra = '') => {
      active.delete(killAsAborted)
      clearTimeout(timer)
      opts.signal.removeEventListener('abort', onAbort)
      const output = dropped ? `${head}\n… [${dropped} characters truncated] …\n${tail}` : head + tail
      resolve({ output: output + extra, exitCode, timedOut, aborted })
    }
    child.on('error', (error) => finish(null, error.message))
    child.on('close', (code) => finish(code))
  })
}

export const bashTool = defineTool({
  name: 'bash',
  description:
    'Run a shell command in the project directory. No interactive input. Default timeout 2 minutes (max 10). Use for tests, builds, git, and other CLI tasks.',
  schema: z.object({
    command: z.string().describe('The shell command to run'),
    timeout_ms: z.number().int().min(1000).max(600000).optional().describe('Timeout in milliseconds'),
  }),
  kind: 'bash',
  target: (input) => input.command,
  async run(input, ctx) {
    const r = await runCommand(input.command, { cwd: ctx.cwd, timeoutMs: input.timeout_ms ?? 120_000, signal: ctx.signal })
    const status = r.timedOut
      ? `[stopped: timeout after ${Math.round((input.timeout_ms ?? 120_000) / 1000)} seconds]`
      : r.aborted
        ? '[cancelled by the user]'
        : `[exit code ${r.exitCode}]`
    return { output: `${r.output.trimEnd()}\n${status}`.trimStart(), isError: r.exitCode !== 0 }
  },
})
