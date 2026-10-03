import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Native glob exclude patterns: node_modules, .git, and simple root .gitignore entries. */
export function ignorePatterns(root: string): string[] {
  const patterns = ['**/node_modules/**', '**/.git/**']
  let lines: string[] = []
  try {
    lines = readFileSync(join(root, '.gitignore'), 'utf8').split(/\r?\n/)
  } catch {
    return patterns
  }
  for (const raw of lines) {
    const line = raw.trim()
    if (!line || line.startsWith('#') || line.startsWith('!')) continue
    const p = line.replace(/^\//, '').replace(/\/$/, '')
    patterns.push(`**/${p}`, `**/${p}/**`)
  }
  return patterns
}
