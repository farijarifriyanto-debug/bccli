import fg from 'fast-glob'
import { ignorePatterns } from '../tools/ignore'
import { validateGlobPattern } from '../tools/globSafety'

export function completeFile(value: string, cwd: string): string {
  const match = /(^|\s)@([^\s]*)$/.exec(value)
  if (!match) return value
  const prefix = match[2]
  const escaped = prefix.replace(/([*?[\]{}()!])/g, '\\$1')
  const pattern = `${escaped}*`
  if (validateGlobPattern(pattern)) return value
  const found = fg
    .sync(pattern, { cwd, ignore: ignorePatterns(cwd), onlyFiles: false, markDirectories: true, dot: false })
    .sort()
  if (!found.length) return value
  const pick = found[0]
  return `${value.slice(0, value.length - prefix.length)}${pick}${pick.endsWith('/') ? '' : ' '}`
}
