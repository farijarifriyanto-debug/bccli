/**
 * Strict npm spec parsing and managed-entry validation for `bccli plugins`.
 * Pure module — no filesystem or process access.
 */

/** Strict npm spec: name | @scope/name | name@version | name@tag (lowercase only). */
const NPM_SPEC_RE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:@[a-z0-9][a-z0-9._+-]*)?$/

/** Bare npm package name only — no version/tag suffix, no traversal/flags/metachars. */
const BARE_NAME_RE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/

const MANAGED_PREFIX = './plugins/node_modules/'

export interface ParsedSpec {
  /** Package name without the @version/@tag suffix; scope preserved. */
  name: string
  /** The original (trimmed) spec, safe to hand to npm argv. */
  spec: string
}

/**
 * Parses an npm install spec. Rejects URLs, git+ssh/github:/file: refs, local
 * paths, flag-like arguments (leading '-'), uppercase, spaces/metachars and
 * npm ranges (^, ~). Returns null when anything is off.
 */
export function parseNpmSpec(raw: string): ParsedSpec | null {
  const spec = raw.trim()
  if (!NPM_SPEC_RE.test(spec)) return null
  const at = spec.lastIndexOf('@')
  const name = at > 0 ? spec.slice(0, at) : spec
  if (!NPM_SPEC_RE.test(name)) return null
  return { name, spec }
}

/** Canonical config entry for a managed package (a config STRING, never join()). */
export function managedEntry(name: string): string {
  return `${MANAGED_PREFIX}${name}`
}

export function isManagedEntry(entry: string): boolean {
  return entry.startsWith(MANAGED_PREFIX)
}

/**
 * Strict validation of a managed entry: canonical prefix + bare npm name suffix.
 * Returns the bare name, or null when the entry is not managed or is malformed
 * (malformed entries must never be handed to npm).
 */
export function managedEntryName(entry: string): string | null {
  if (!isManagedEntry(entry)) return null
  const rest = entry.slice(MANAGED_PREFIX.length)
  return BARE_NAME_RE.test(rest) ? rest : null
}
