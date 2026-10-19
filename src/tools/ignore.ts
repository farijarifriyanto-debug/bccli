import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/** Native glob exclude patterns: node_modules, .git, and .gitignore entries up to projectRoot. */
export function ignorePatterns(root: string, projectRoot?: string): string[] {
  const patterns = ['**/node_modules/**', '**/.git/**']
  const seen = new Set<string>()
  const dirs: string[] = []
  let cur = resolve(root)
  const stop = projectRoot ? resolve(projectRoot) : cur
  while (true) {
    if (!seen.has(cur)) {
      seen.add(cur)
      dirs.push(cur)
    }
    if (cur === stop || !cur.startsWith(stop)) break
    const parent = dirname(cur)
    if (parent === cur) break
    cur = parent
  }
  for (const dir of dirs) {
    let lines: string[] = []
    try {
      lines = readFileSync(join(dir, '.gitignore'), 'utf8').split(/\r?\n/)
    } catch {
      continue
    }
    for (const raw of lines) {
      const line = raw.trim()
      if (!line || line.startsWith('#') || line.startsWith('!')) continue
      const p = line.replace(/^\//, '').replace(/\/$/, '')
      patterns.push(`**/${p}`, `**/${p}/**`)
    }
  }
  return [...new Set(patterns)]
}
