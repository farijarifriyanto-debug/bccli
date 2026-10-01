import { execFile } from 'node:child_process'
import { t } from '../i18n'

function git(cwd: string, args: string[], bin = 'git'): Promise<{ ok: boolean; out: string; missing?: boolean }> {
  return new Promise((resolve) => {
    execFile(bin, args, { cwd, maxBuffer: 20 * 1024 * 1024 }, (error, stdout, stderr) =>
      resolve({ ok: !error, out: error ? stderr : stdout, missing: (error as NodeJS.ErrnoException | null)?.code === 'ENOENT' }),
    )
  })
}

export async function gitDiff(cwd: string, maxLines = 400, bin = 'git'): Promise<string> {
  const inside = await git(cwd, ['rev-parse', '--is-inside-work-tree'], bin)
  if (inside.missing) return t('git is not installed or not on PATH, so /diff cannot be used.')
  if (!inside.ok || inside.out.trim() !== 'true') return t('This folder is not a git repository, so there is no diff.')
  // Against HEAD so staged changes show too; before the first commit, against the empty tree.
  const base = (await git(cwd, ['rev-parse', '--verify', '-q', 'HEAD'])).ok ? 'HEAD' : '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
  const [stat, diff, untracked] = await Promise.all([
    git(cwd, ['diff', '--stat', base]),
    git(cwd, ['diff', base]),
    git(cwd, ['ls-files', '--others', '--exclude-standard']),
  ])
  const fresh = untracked.out.split('\n').filter(Boolean)
  if (!diff.out.trim() && !fresh.length) return t('No uncommitted changes.')
  const lines = diff.out.trimEnd().split('\n')
  const more = lines.length > maxLines ? `\n${t('… {n} more lines', { n: lines.length - maxLines })}` : ''
  return [stat.out.trim(), lines.slice(0, maxLines).join('\n') + more, fresh.length ? t('New files (untracked): {files}', { files: fresh.join(', ') }) : '']
    .filter(Boolean)
    .join('\n\n')
}
