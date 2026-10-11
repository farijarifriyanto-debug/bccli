import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { delimiter, posix, win32 } from 'node:path'

/**
 * Synchronous npm runner. On Windows it NEVER goes through cmd.exe: npm's own
 * npm.cmd is just a shim around `node …\node_modules\npm\bin\npm-cli.js`, so we
 * invoke that script with process.execPath and pass every argument as plain
 * argv. Shell metacharacters in the prefix path (& % ( ) spaces, …) therefore
 * need no quoting at all — nothing is ever joined into a command line.
 */

export interface NpmRunResult {
  code: number
  stderr: string
  stdout?: string
}

export interface RunNpmOptions {
  platform?: NodeJS.Platform
  spawn?: typeof spawnSync
  env?: NodeJS.ProcessEnv
  exists?: (path: string) => boolean
  execPath?: string
}

function findNpmCli(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, exists: (p: string) => boolean, execPath: string): string | null {
  // Use win32 path semantics when platform is win32, even on POSIX hosts (tests).
  const path = platform === 'win32' ? win32 : posix
  const sibling = path.join(path.dirname(execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  if (exists(sibling)) return sibling
  const sep = platform === 'win32' ? ';' : delimiter
  for (const dir of (env.PATH ?? '').split(sep)) {
    if (!dir) continue
    const shim = path.join(dir, platform === 'win32' ? 'npm.cmd' : 'npm')
    if (!exists(shim)) continue
    const cli = path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js')
    if (exists(cli)) return cli
  }
  return null
}

interface SpawnLikeResult {
  status?: number | null
  stdout?: string | Buffer | null
  stderr?: string | Buffer | null
  error?: Error | null
}

const text = (v: string | Buffer | null | undefined): string => (typeof v === 'string' ? v : v ? v.toString() : '')

function toResult(r: SpawnLikeResult): NpmRunResult {
  return {
    code: r.status ?? 1,
    stderr: text(r.stderr) || (r.error ? r.error.message : ''),
    stdout: text(r.stdout),
  }
}

export function runNpmSync(prefix: string, argv: string[], opts: RunNpmOptions = {}): NpmRunResult {
  const platform = opts.platform ?? process.platform
  const spawn = opts.spawn ?? spawnSync
  const env = opts.env ?? process.env
  const exists = opts.exists ?? existsSync
  const execPath = opts.execPath ?? process.execPath

  if (platform !== 'win32') {
    // POSIX npm is a shebang script — direct exec works without any shell.
    return toResult(spawn('npm', ['--prefix', prefix, ...argv], { encoding: 'utf8', env }))
  }

  const cli = findNpmCli(platform, env, exists, execPath)
  if (!cli) {
    return { code: 1, stderr: 'npm CLI not found (looked beside the node executable and on PATH)' }
  }
  return toResult(spawn(execPath, [cli, '--prefix', prefix, ...argv], { encoding: 'utf8', env }))
}
