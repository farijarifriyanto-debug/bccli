import { execFile } from 'node:child_process'

function git(cwd: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, maxBuffer: 20 * 1024 * 1024 }, (error, stdout, stderr) => resolve({ ok: !error, out: error ? stderr : stdout }))
  })
}

export async function gitDiff(cwd: string, maxLines = 400): Promise<string> {
  const inside = await git(cwd, ['rev-parse', '--is-inside-work-tree'])
  if (!inside.ok || inside.out.trim() !== 'true') return 'Folder ini bukan repository git, jadi tidak ada diff.'
  // Against HEAD so staged changes show too; before the first commit, against the empty tree.
  const base = (await git(cwd, ['rev-parse', '--verify', '-q', 'HEAD'])).ok ? 'HEAD' : '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
  const [stat, diff, untracked] = await Promise.all([
    git(cwd, ['diff', '--stat', base]),
    git(cwd, ['diff', base]),
    git(cwd, ['ls-files', '--others', '--exclude-standard']),
  ])
  const fresh = untracked.out.split('\n').filter(Boolean)
  if (!diff.out.trim() && !fresh.length) return 'Tidak ada perubahan yang belum di-commit.'
  const lines = diff.out.trimEnd().split('\n')
  const more = lines.length > maxLines ? `\n… ${lines.length - maxLines} baris lagi` : ''
  return [stat.out.trim(), lines.slice(0, maxLines).join('\n') + more, fresh.length ? `File baru (belum di-track): ${fresh.join(', ')}` : '']
    .filter(Boolean)
    .join('\n\n')
}
