import { spawn } from 'node:child_process'
import { t } from './i18n'

export type HookEvent = 'PreToolUse' | 'PostToolUse' | 'SessionStart' | 'Stop'

export interface HookRule {
  /** Glob over the tool name ('*' matches everything, omitted = every tool). Tool events only. */
  match?: string
  command: string
}

export type HooksConfig = Partial<Record<HookEvent, HookRule[]>>

export interface HookOutcome {
  /** PreToolUse only: the tool call is denied with this message instead of running. */
  blocked?: string
  warnings: string[]
}

export interface HookRunOptions {
  env?: NodeJS.ProcessEnv
  cwd?: string
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 10_000
const MAX_CAPTURE = 8_192

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '.*')
  return new RegExp(`^${escaped}$`)
}

interface RunResult {
  blocked?: string
  /** Failure detail (exit code, timeout, spawn error); only the run event decides whether it blocks. */
  failure?: string
}

function runOne(
  command: string,
  event: HookEvent,
  payload: { tool?: string; input?: unknown; output?: string },
  opts: HookRunOptions,
): Promise<RunResult> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...opts.env,
    BCCLI_HOOK_EVENT: event,
    ...(payload.tool !== undefined ? { BCCLI_HOOK_TOOL: payload.tool } : {}),
    ...(payload.input !== undefined ? { BCCLI_HOOK_INPUT: JSON.stringify(payload.input) } : {}),
    ...(payload.output !== undefined ? { BCCLI_HOOK_OUTPUT: payload.output } : {}),
  }
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false
    const finish = (result: RunResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(command, { shell: true, env, cwd: opts.cwd ?? process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      resolve({ failure: (error as Error).message })
      return
    }
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < MAX_CAPTURE) stdout += String(chunk)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_CAPTURE) stderr += String(chunk)
    })
    child.on('error', (error) => finish({ failure: error.message }))
    child.on('close', (code) => {
      if (timedOut) {
        finish({ failure: 'timed out' })
        return
      }
      if (event === 'PreToolUse' && code === 2) {
        finish({ blocked: stderr.trim() || stdout.trim() || 'Blocked by a PreToolUse hook.' })
        return
      }
      if (code !== 0) {
        const detail = stderr.trim().split('\n')[0]
        finish({ failure: detail ? `exit ${code}: ${detail}` : `exit ${code}` })
        return
      }
      finish({})
    })
  })
}

/**
 * Runs the configured hooks for one event, in order. A PreToolUse hook that exits
 * with code 2 blocks the tool call (Claude Code semantics); any other failure is a
 * non-blocking warning. Hooks receive BCCLI_HOOK_EVENT/TOOL/INPUT/OUTPUT env vars.
 */
export async function runHooks(
  hooks: HooksConfig | undefined,
  event: HookEvent,
  payload: { tool?: string; input?: unknown; output?: string } = {},
  opts: HookRunOptions = {},
): Promise<HookOutcome> {
  const rules = hooks?.[event]
  if (!Array.isArray(rules) || rules.length === 0) return { warnings: [] }
  const warnings: string[] = []
  let blocked: string | undefined
  for (const rule of rules) {
    if (!rule || typeof rule.command !== 'string' || rule.command.length === 0) continue
    if (payload.tool !== undefined && rule.match && !globToRegExp(rule.match).test(payload.tool)) continue
    const result = await runOne(rule.command, event, payload, opts)
    if (result.blocked) {
      blocked = result.blocked
      break
    }
    if (result.failure) warnings.push(t('Hook {event} failed: {reason}', { event, reason: result.failure }))
  }
  return { blocked, warnings }
}
