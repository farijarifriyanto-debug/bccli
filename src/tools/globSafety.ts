const MAX_GLOB_LENGTH = 4096
const MAX_BRACE_DEPTH = 16

/**
 * Reject glob inputs that can trigger pathological brace expansion before they
 * reach fast-glob/micromatch/braces. Backslash-escaped braces are literals.
 */
export function validateGlobPattern(pattern: string): string | undefined {
  if (pattern.length > MAX_GLOB_LENGTH) return `Glob pattern is too long (max ${MAX_GLOB_LENGTH} characters).`

  let depth = 0
  let escaped = false
  for (const char of pattern) {
    if (escaped) {
      escaped = false
      continue
    }
    if (char === '\\') {
      escaped = true
      continue
    }
    if (char === '{') {
      depth++
      if (depth > MAX_BRACE_DEPTH) return `Glob brace nesting is too deep (max ${MAX_BRACE_DEPTH}).`
    } else if (char === '}' && depth > 0) {
      depth--
    }
  }
  return undefined
}
