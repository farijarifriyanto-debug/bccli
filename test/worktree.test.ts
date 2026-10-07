import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { expect, test } from 'vitest'
import { SLASH_COMMANDS } from '../src/commands'
import { resolveWorktree, worktreeListText } from '../src/worktree'

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=bccli-test', '-c', 'user.email=bccli@test', ...args], { cwd, stdio: 'pipe' }).toString()

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bccli-wt-'))
  git(dir, 'init')
  writeFileSync(join(dir, 'a.txt'), 'hi')
  git(dir, 'add', '.')
  git(dir, 'commit', '-m', 'init')
  return dir
}

test('creates a sibling worktree on a new branch and reuses it next time', async () => {
  const dir = repo()
  const first = await resolveWorktree(dir, 'feat-a')
  expect(first.created).toBe(true)
  expect(first.path).toBe(join(dirname(dir), `${basename(dir)}.worktrees`, 'feat-a'))
  expect(existsSync(join(first.path, 'a.txt'))).toBe(true)
  const second = await resolveWorktree(dir, 'feat-a')
  expect(second.created).toBe(false)
  expect(second.path).toBe(first.path)
})

test('rejects unsafe names, non-repos, and missing git', async () => {
  const dir = repo()
  // The suite runs in Indonesian, so assert stable tokens instead of English prose.
  await expect(resolveWorktree(dir, '../evil')).rejects.toThrow(/\.\.\/evil/)
  await expect(resolveWorktree(dir, 'a/b')).rejects.toThrow(/a\/b/)
  const plain = mkdtempSync(join(tmpdir(), 'bccli-norepo-'))
  await expect(resolveWorktree(plain, 'x')).rejects.toThrow(/worktree/i)
  await expect(resolveWorktree(dir, 'x', 'git-not-installed-xyz')).rejects.toThrow(/git/)
})

test('an existing but unregistered path is not clobbered', async () => {
  const dir = repo()
  mkdirSync(join(dirname(dir), `${basename(dir)}.worktrees`, 'occupied'), { recursive: true })
  await expect(resolveWorktree(dir, 'occupied')).rejects.toThrow(/occupied/)
})

test('the status text lists worktrees with a remove hint', async () => {
  const dir = repo()
  const wt = await resolveWorktree(dir, 'feat-b')
  const text = await worktreeListText(dir)
  const norm = (p: string) => p.replace(/[\\/]+/g, '/')
  expect(norm(text)).toContain(norm(wt.path))
  expect(text).toMatch(/git worktree remove/)
  const plain = mkdtempSync(join(tmpdir(), 'bccli-nr2-'))
  expect(await worktreeListText(plain)).toMatch(/git/i)
})

test('the /worktree command is registered with a status description', () => {
  const cmd = SLASH_COMMANDS.find((c) => c.name === 'worktree')
  expect(cmd).toBeDefined()
  expect(cmd?.description).toMatch(/worktree/i)
})
