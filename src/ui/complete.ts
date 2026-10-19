import { existsSync, globSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { requiresSensitiveToolApproval } from '../permissions'
import { ignorePatterns } from '../tools/ignore'
import { normalizeGlobPath, validateGlobPattern } from '../tools/globSafety'
import { recordFileMtime } from '../tools/paths'

const MAX_ATTACH_BYTES = 32_768

export function listFileSuggestions(value: string, cwd: string, limit = 8): string[] {
  const match = /(^|\s)@([^\s]*)$/.exec(value)
  if (!match) return []
  const prefix = match[2]
  const escaped = prefix.replace(/([*?[\]{}()!])/g, '\\$1')
  const pattern = `${escaped}*`
  if (validateGlobPattern(pattern)) return []
  const exclude = ignorePatterns(cwd)
  const formatEntry = (entry: string) => {
    const normalized = normalizeGlobPath(entry)
    try {
      return statSync(join(cwd, entry)).isDirectory() ? `${normalized}/` : normalized
    } catch {
      return normalized
    }
  }
  try {
    let found = globSync(pattern, { cwd, exclude }).map(formatEntry).sort()
    if (!found.length && prefix && !prefix.includes('/')) {
      const deepPattern = `**/*${escaped}*`
      if (!validateGlobPattern(deepPattern)) {
        found = globSync(deepPattern, { cwd, exclude })
          .map(formatEntry)
          .sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b))
      }
    }
    return found.slice(0, limit)
  } catch {
    return []
  }
}

export function applyFileSuggestion(value: string, pick: string): string {
  const match = /(^|\s)@([^\s]*)$/.exec(value)
  if (!match) return value
  const prefix = match[2]
  return `${value.slice(0, value.length - prefix.length)}${pick}${pick.endsWith('/') ? '' : ' '}`
}

export function completeFile(value: string, cwd: string): string {
  const found = listFileSuggestions(value, cwd, 1)
  if (!found.length) return value
  return applyFileSuggestion(value, found[0])
}

/**
 * Pre-attaches small non-secret project files referenced via `@path/to/file` in a user prompt,
 * and records them in `readFiles` so the model can inspect or edit them without an extra tool turn.
 */
export function expandAtFileMentions(prompt: string, cwd: string, readFiles?: Set<string>): string {
  const matches = [...prompt.matchAll(/(?:^|\s)@([^\s]+)/g)]
  if (!matches.length) return prompt
  const blocks: string[] = []
  const seen = new Set<string>()
  for (const m of matches) {
    const rawPath = m[1]
    if (!rawPath || seen.has(rawPath)) continue
    seen.add(rawPath)
    if (requiresSensitiveToolApproval({ tool: 'read', kind: 'read', target: rawPath })) continue
    const abs = resolve(cwd, rawPath)
    const rel = relative(cwd, abs)
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) continue
    try {
      if (!existsSync(abs) || !statSync(abs).isFile() || statSync(abs).size > MAX_ATTACH_BYTES) continue
      const buf = readFileSync(abs)
      if (buf.subarray(0, 4000).includes(0)) continue
      if (readFiles) recordFileMtime(readFiles, abs)
      blocks.push(`<file path="${rawPath}">\n${buf.toString('utf8')}\n</file>`)
    } catch {
      // skip unreadable files
    }
  }
  return blocks.length ? `${prompt}\n\n${blocks.join('\n\n')}` : prompt
}
