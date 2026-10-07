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
  for (const task of backgrounds.values()) if (task.status === 'running') task.kill()
}

interface BackgroundTask {
  id: number
  command: string
  startedAt: number
  status: 'running' | 'exited'
  killed: boolean
  exitCode: number | null
  head: string
  tail: string
  dropped: number
  kill: () => void
}

const backgrounds = new Map<number, BackgroundTask>()
let nextBackgroundId = 1

function startBackground(command: string, cwd: string, env?: NodeJS.ProcessEnv): BackgroundTask {
  const child = spawn(command, {
    cwd,
    shell: true,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  })
  const task: BackgroundTask = {
    id: nextBackgroundId++,
    command,
    startedAt: Date.now(),
    status: 'running',
    killed: false,
    exitCode: null,
    head: '',
    tail: '',
    dropped: 0,
    kill: () => {},
  }
  task.kill = () => {
    if (task.status !== 'running') return
    task.killed = true
    if (child.pid !== undefined) killProcessTree(child.pid)
  }
  backgrounds.set(task.id, task)
  const onData = (data: string) => {
    let s = data
    if (task.head.length < HALF) {
      const take = s.slice(0, HALF - task.head.length)
      task.head += take
      s = s.slice(take.length)
    }
    if (s) {
      task.tail += s
      if (task.tail.length > HALF) {
        task.dropped += task.tail.length - HALF
        task.tail = task.tail.slice(-HALF)
      }
    }
  }
  child.stdout?.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')
  child.stdout?.on('data', onData)
  child.stderr?.on('data', onData)
  child.on('error', (error) => {
    task.status = 'exited'
    task.head += `${task.head ? '\n' : ''}${error.message}`
  })
  child.on('close', (code) => {
    task.status = 'exited'
    task.exitCode = code
  })
  return task
}

function backgroundStatus(task: BackgroundTask): string {
  if (task.status === 'running') return `[running ${Math.round((Date.now() - task.startedAt) / 1000)}s]`
  if (task.killed) return '[killed]'
  return `[exit code ${task.exitCode}]`
}

function backgroundOutput(task: BackgroundTask): string {
  const body = task.dropped
    ? `${task.head}\n… [${task.dropped} characters truncated] …\n${task.tail}`
    : task.head + task.tail
  return `${body.trimEnd()}\n${backgroundStatus(task)}`.trimStart()
}

/** Human-readable list for the /tasks slash command. */
export function renderBackgroundTasks(): string {
  if (!backgrounds.size) return 'No background tasks.'
  const lines = [...backgrounds.values()].sort((a, b) => a.id - b.id).flatMap((task) => {
    const output = backgroundOutput(task)
    const tailLines = output.split('\n').slice(-6)
    return [`#${task.id} ${backgroundStatus(task)}  ${task.command}`, ...tailLines.map((line) => `    ${line}`)]
  })
  return `Background tasks:\n${lines.join('\n')}`
}

/** Test/exit helper: stop every background task and forget them. */
export function resetBackgroundTasks(): void {
  for (const task of backgrounds.values()) if (task.status === 'running') task.kill()
  backgrounds.clear()
}

export interface CommandResult {
  output: string
  exitCode: number | null
  timedOut: boolean
  aborted: boolean
}

/** Best-effort detection of commands that reach the internet (networkPolicy "offline"). */
const NETWORK_PATTERNS: RegExp[] = [
  /\b(curl|wget|ftp|scp|sftp|rsync|lynx|telnet)\b/i,
  /\bssh\b/i,
  /\b(Invoke-WebRequest|Invoke-RestMethod|iwr|irm)\b/i,
  /\bgit\s+(clone|fetch|pull|push|remote|ls-remote|submodule|request-pull)\b/i,
  /\b(npm|pnpm|yarn|bun)\s+(install|ci|add|update|upgrade|publish|dist-tag)\b/i,
  /\b(pip3?|pipx)\s+install\b/i,
  /\b(uv|poetry|conda)\s+(pip\s+)?(install|add|update|upgrade)\b/i,
  /\bcargo\s+(install|publish|search)\b/i,
  /\bgo\s+(get|install|mod\s+download)\b/i,
  /\b(docker|podman)\s+(pull|push)\b/i,
  /\bgh\s+(pr|repo|release|run|api|auth|browse|search|issue|gist|status)\b/i,
  /\b(apt|apt-get|yum|dnf|pacman|brew|choco|winget|scoop)\s+(install|update|upgrade|add)\b/i,
  /\bterraform\s+(init|get)\b/i,
]

export function needsNetwork(command: string): boolean {
  return NETWORK_PATTERNS.some((pattern) => pattern.test(command))
}

/** Proxy env pointing at a dead local port: tools that honour proxy vars fail fast offline. */
export function offlineEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const dead = 'http://127.0.0.1:9'
  return {
    ...env,
    HTTP_PROXY: dead,
    HTTPS_PROXY: dead,
    ALL_PROXY: dead,
    NO_PROXY: '',
    http_proxy: dead,
    https_proxy: dead,
    all_proxy: dead,
    no_proxy: '',
  }
}

export function runCommand(
  command: string,
  opts: { cwd: string; timeoutMs: number; signal: AbortSignal; env?: NodeJS.ProcessEnv },
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd: opts.cwd,
      shell: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: opts.env,
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

const BASH_DESCRIPTION =
  'Run a shell command in the project directory. No interactive input. Default timeout 2 minutes (max 10). Use for tests, builds, git, and other CLI tasks. Set background: true for long-running jobs, then poll with task_id (stop with kill: true) or use the /tasks command.'

const BASH_SCHEMA = z.object({
  command: z.string().optional().describe('The shell command to run (required unless task_id is set)'),
  timeout_ms: z.number().int().min(1000).max(600000).optional().describe('Timeout in milliseconds'),
  background: z
    .boolean()
    .optional()
    .describe('Start the command in the background and return its task id immediately'),
  task_id: z
    .number()
    .int()
    .optional()
    .describe('Poll a background task started with background: true (omit command)'),
  kill: z.boolean().optional().describe('With task_id: stop the background task'),
})

export interface BashToolOptions {
  /** "offline" blocks known network commands and points proxy env at a dead local port. */
  networkPolicy?: 'allow' | 'offline'
}

export function createBashTool(options: BashToolOptions = {}) {
  const offline = options.networkPolicy === 'offline'
  const childEnv = offline ? offlineEnv() : undefined
  const description = offline
    ? `${BASH_DESCRIPTION}\nNetwork access is off (networkPolicy "offline"): internet commands such as curl, wget, git fetch/push/clone, package installs (npm, pip, ...), gh, and docker pull are blocked.`
    : BASH_DESCRIPTION
  return defineTool({
    name: 'bash',
    description,
    schema: BASH_SCHEMA,
    kind: 'bash',
    target: (input: z.infer<typeof BASH_SCHEMA>) => input.command ?? (input.task_id !== undefined ? `#${input.task_id}` : '(no command)'),
    async run(input: z.infer<typeof BASH_SCHEMA>, ctx) {
      if (input.task_id !== undefined) {
        const task = backgrounds.get(input.task_id)
        if (!task) return { output: `No background task #${input.task_id}. Start one with {background: true}.`, isError: true }
        if (input.kill) {
          if (task.status !== 'running') return { output: `Background task #${task.id} already finished ${backgroundStatus(task)}.` }
          task.kill()
          return { output: `Killed background task #${task.id}.` }
        }
        return {
          output: backgroundOutput(task),
          isError: task.status === 'exited' && !task.killed && task.exitCode !== 0,
        }
      }
      if (input.command && offline && needsNetwork(input.command)) {
        return {
          output: `Blocked by networkPolicy "offline": "${input.command.slice(0, 120)}" needs the network. Set "networkPolicy": "allow" in ~/.bccli/config.json to enable network commands.`,
          isError: true,
        }
      }
      if (input.background) {
        if (!input.command) return { output: 'The "command" argument is required to start a background task.', isError: true }
        const task = startBackground(input.command, ctx.cwd, childEnv)
        return {
          output: `Background task #${task.id} started: ${input.command}\nPoll it with {task_id: ${task.id}}; stop it with {task_id: ${task.id}, kill: true}.`,
        }
      }
      if (!input.command) {
        return { output: 'The "command" argument is required (or set task_id to poll a background task).', isError: true }
      }
      const r = await runCommand(input.command, {
        cwd: ctx.cwd,
        timeoutMs: input.timeout_ms ?? 120_000,
        signal: ctx.signal,
        env: childEnv,
      })
      const status = r.timedOut
        ? `[stopped: timeout after ${Math.round((input.timeout_ms ?? 120_000) / 1000)} seconds]`
        : r.aborted
          ? '[cancelled by the user]'
          : `[exit code ${r.exitCode}]`
      return { output: `${r.output.trimEnd()}\n${status}`.trimStart(), isError: r.exitCode !== 0 }
    },
  })
}

export const bashTool = createBashTool()
