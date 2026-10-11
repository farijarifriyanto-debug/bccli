import { existsSync } from 'node:fs'
import { win32 } from 'node:path'

/**
 * How a command string is run. `undefined` (posix) keeps the default `sh -c` behaviour.
 * On Windows we never use cmd.exe: Git Bash gives the usual Unix tools (tail, grep, ls,
 * sed); without it we fall back to Windows PowerShell with UTF-8 output.
 */
export interface ShellSpec {
  name: 'bash' | 'powershell'
  file: string
  args: (command: string) => string[]
}

export interface ShellDeps {
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  exists: (path: string) => boolean
}

const PS_PRELUDE = '[Console]::OutputEncoding=[Text.Encoding]::UTF8; $OutputEncoding=[Text.Encoding]::UTF8; '
// Propagate the native exit code; fall back to $? when no native command ran.
const PS_EPILOGUE = '\nif ($LASTEXITCODE -ne $null) { exit $LASTEXITCODE } elseif (-not $?) { exit 1 }'

function gitBashCandidates(env: NodeJS.ProcessEnv): string[] {
  const roots = [env.ProgramW6432, env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA && win32.join(env.LOCALAPPDATA, 'Programs')]
  const fromRoots = roots.filter((root): root is string => !!root).map((root) => win32.join(root, 'Git', 'bin', 'bash.exe'))
  // git.exe on PATH usually sits in <Git>\cmd; the bash lives in <Git>\bin.
  const fromPath = (env.PATH ?? env.Path ?? '')
    .split(';')
    .filter(Boolean)
    .map((dir) => win32.join(dir, '..', 'bin', 'bash.exe'))
  return [...fromRoots, ...fromPath]
}

export function resolveShell(deps: ShellDeps): ShellSpec | undefined {
  if (deps.platform !== 'win32') return undefined
  const bash = gitBashCandidates(deps.env).find((candidate) => deps.exists(candidate))
  if (bash) return { name: 'bash', file: bash, args: (command) => ['-c', command] }
  return {
    name: 'powershell',
    file: 'powershell.exe',
    args: (command) => [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
      Buffer.from(PS_PRELUDE + command + PS_EPILOGUE, 'utf16le').toString('base64'),
    ],
  }
}

let cachedDefault: ShellSpec | undefined | null = null

/** Shell for the current machine, resolved once. */
export function defaultShell(): ShellSpec | undefined {
  if (cachedDefault === null) cachedDefault = resolveShell({ platform: process.platform, env: process.env, exists: existsSync })
  return cachedDefault
}
