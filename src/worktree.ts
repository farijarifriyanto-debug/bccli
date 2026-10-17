import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { ConfigError } from './config'
import { t } from './i18n'

function git(cwd: string, args: string[], bin = 'git'): Promise<{ ok: boolean; out: string; missing?: boolean }> {
  return new Promise((resolve) => {
    execFile(bin, args, { cwd, maxBuffer: 20 * 1024 * 1024 }, (error, stdout, stderr) =>
      resolve({ ok: !error, out: error ? stderr : stdout, missing: (error as NodeJS.ErrnoException | null)?.code === 'ENOENT' }),
    )
  })
}

const NAME_RE = /^[A-Za-z0-9._-]+$/

/** Loose path equality across git's forward slashes and Windows separators. */
function samePath(a: string, b: string): boolean {
  const norm = (p: string) => (process.platform === 'win32' ? p.replace(/\//g, '\\').toLowerCase() : p.replace(/\\/g, '/'))
  return norm(a) === norm(b)
}

function worktreeEntries(porcelain: string): { path: string; branch?: string }[] {
  return porcelain
    .split(/\r?\n\r?\n/)
    .map((block) => {
      const path = /^worktree (.+)$/m.exec(block)?.[1]?.trim()
      if (!path) return undefined
      const branch = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1]
      return branch ? { path, branch } : { path }
    })
    .filter((entry): entry is { path: string; branch?: string } => !!entry)
}

export interface WorktreePlan {
  path: string
  created: boolean
}

/**
 * Resolve (creating when needed) the sibling worktree for `-w <name>`: always derived from the
 * MAIN checkout, so running inside an existing worktree nests nothing. The returned path becomes
 * the session cwd, so config, prompts, sessions, and permissions all follow it.
 */
export async function resolveWorktree(cwd: string, name: string, bin = 'git'): Promise<WorktreePlan> {
  if (!NAME_RE.test(name)) {
    throw new ConfigError(t('Invalid worktree name "{name}": use letters, digits, dot, dash, or underscore (no slashes).', { name }))
  }
  const inside = await git(cwd, ['rev-parse', '--is-inside-work-tree'], bin)
  if (inside.missing) throw new ConfigError(t('git is not installed or not on PATH, so -w cannot be used.'))
  if (!inside.ok || inside.out.trim() !== 'true') throw new ConfigError(t('This folder is not a git repository, so -w cannot create a worktree.'))
  const list = await git(cwd, ['worktree', 'list', '--porcelain'], bin)
  if (!list.ok) throw new ConfigError(t('This folder is not a git repository, so -w cannot create a worktree.'))
  const entries = worktreeEntries(list.out)
  const main = entries[0]?.path
  if (!main) throw new ConfigError(t('This folder is not a git repository, so -w cannot create a worktree.'))
  const path = join(dirname(main), `${basename(main)}.worktrees`, name)
  if (entries.some((entry) => samePath(entry.path, path))) return { path, created: false }
  if (existsSync(path)) {
    throw new ConfigError(t('Worktree path {path} already exists but is not a registered worktree; remove or rename it first.', { path }))
  }
  const branch = `bccli/${name}`
  const hasBranch = (await git(main, ['rev-parse', '--verify', '-q', `refs/heads/${branch}`], bin)).ok
  const add = hasBranch
    ? await git(main, ['worktree', 'add', path, branch], bin)
    : await git(main, ['worktree', 'add', '-b', branch, path], bin)
  if (!add.ok) throw new ConfigError(add.out.trim() || t('This folder is not a git repository, so -w cannot create a worktree.'))
  return { path, created: true }
}

/** Read-only status for /worktree: what exists and how to remove it safely. */
export async function worktreeListText(cwd: string, bin = 'git'): Promise<string> {
  const inside = await git(cwd, ['rev-parse', '--is-inside-work-tree'], bin)
  if (inside.missing) return t('git is not installed or not on PATH, so /worktree cannot be used.')
  if (!inside.ok || inside.out.trim() !== 'true') return t('This folder is not a git repository, so there is no diff.')
  const list = await git(cwd, ['worktree', 'list', '--porcelain'], bin)
  if (!list.ok) return t('This folder is not a git repository, so there is no diff.')
  const rows = worktreeEntries(list.out).map((entry) => `  ${entry.path}${entry.branch ? ` (${entry.branch})` : ''}`)
  return [
    t('Git worktrees:'),
    ...rows,
    '',
    t('Create one with: bccli -w <name>'),
    t('Remove with: git worktree remove <path>'),
  ].join('\n')
}
