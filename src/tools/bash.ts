import { spawn } from 'node:child_process'
import { z } from 'zod'
import { defineTool } from './types'

const HALF = 15_000

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
    let head = ''
    let tail = ''
    let dropped = 0
    let timedOut = false
    let aborted = false
    const onData = (data: Buffer) => {
      let s = data.toString()
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
      if (child.pid === undefined) return
      if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'])
      else {
        try {
          process.kill(-child.pid, 'SIGKILL')
        } catch {
          child.kill('SIGKILL')
        }
      }
    }
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
      clearTimeout(timer)
      opts.signal.removeEventListener('abort', onAbort)
      const output = dropped ? `${head}\n… [${dropped} karakter dipotong] …\n${tail}` : head + tail
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
      ? `[dihentikan: timeout ${Math.round((input.timeout_ms ?? 120_000) / 1000)} detik]`
      : r.aborted
        ? '[dibatalkan user]'
        : `[exit code ${r.exitCode}]`
    return { output: `${r.output.trimEnd()}\n${status}`.trimStart(), isError: r.exitCode !== 0 }
  },
})
