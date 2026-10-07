import { t } from './i18n'
import { runCommand } from './tools/bash'

export interface VerifyFailure {
  cmd: string
  exitCode: number
  output: string
}

/** Fix rounds per user turn; keeps a failing verify command from looping forever. */
export const MAX_VERIFY_ROUNDS = 2

export async function runVerify(
  commands: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; signal: AbortSignal; timeoutMs?: number; run?: typeof runCommand },
): Promise<VerifyFailure[]> {
  const run = opts.run ?? runCommand
  const failures: VerifyFailure[] = []
  for (const cmd of commands) {
    const r = await run(cmd, { cwd: opts.cwd, timeoutMs: opts.timeoutMs ?? 300_000, signal: opts.signal, env: opts.env })
    if (r.exitCode !== 0) failures.push({ cmd, exitCode: r.exitCode, output: r.output })
  }
  return failures
}

export function verifyFollowup(failures: VerifyFailure[], maxBytes = 8000): string {
  const blocks = failures.map((f) => {
    const output = f.output.length > maxBytes ? `${f.output.slice(0, maxBytes)}\n[truncated]` : f.output
    return `$ ${f.cmd}\n[exit code ${f.exitCode}]\n${output}`
  })
  return t('Automatic verification after your edits failed. Fix the problems so these commands pass, then stop.\n\n{blocks}', {
    blocks: blocks.join('\n\n'),
  })
}
