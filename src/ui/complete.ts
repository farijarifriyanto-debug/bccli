import { globSync } from 'node:fs'
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { ignorePatterns } from '../tools/ignore'
import { validateGlobPattern } from '../tools/globSafety'

export function completeFile(value: string, cwd: string): string {
  const match = /(^|\s)@([^\s]*)$/.exec(value)
  if (!match) return value
  const prefix = match[2]
  const escaped = prefix.replace(/([*?[\]{}()!])/g, '\\$1')
  const pattern = `${escaped}*`
  if (validateGlobPattern(pattern)) return value
  const found = globSync(pattern, { cwd, exclude: ignorePatterns(cwd) })
    .map((entry) => {
      try {
        return statSync(join(cwd, entry)).isDirectory() ? `${entry}/` : entry
      } catch {
        return entry
      }
    })
    .sort()
  if (!found.length) return value
  const pick = found[0]
  return `${value.slice(0, value.length - prefix.length)}${pick}${pick.endsWith('/') ? '' : ' '}`
}
