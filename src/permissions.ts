import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { PermissionMode } from './config'
import type { PermissionKind } from './tools/types'

export interface PermissionRequest {
  tool: string
  kind: PermissionKind
  target: string
}

export type Decision = 'allow' | 'deny' | 'ask'

export const MODE_ORDER: PermissionMode[] = ['default', 'acceptEdits', 'plan', 'allowAll']

export function nextMode(mode: PermissionMode): PermissionMode {
  return MODE_ORDER[(MODE_ORDER.indexOf(mode) + 1) % MODE_ORDER.length]
}

// First word that must never be granted for a session, whatever the arguments.
const ALWAYS_ASK_COMMANDS = new Set(['sudo', 'sh', 'bash', 'zsh', 'su'])

/**
 * A segment that may hide destructive effects behind an otherwise harmless name;
 * `rulesFor` returns undefined for requests containing one, so they are always asked.
 */
function isAlwaysAsk(segment: string): boolean {
  const words = segment.trim().split(/\s+/)
  const first = words[0] ?? ''
  if (ALWAYS_ASK_COMMANDS.has(first)) return true
  const flags = words.slice(1).filter((w) => w.startsWith('-'))
  if (first === 'rm' && flags.some((w) => w.includes('r'))) return true // -r, -rf, -fr, --recursive
  if (first === 'chmod' && flags.some((w) => w.includes('R'))) return true // -R, -Rf
  if (first === 'kill' && words.slice(1).includes('-9')) return true
  if (first === 'git' && words[1] === 'push') {
    return words.slice(2).some((w) => w === '-f' || w === '--force' || w.startsWith('--force='))
  }
  return false
}

function commandKey(segment: string): string {
  const words = segment.trim().split(/\s+/)
  return words[1] ? `${words[0]} ${words[1]}` : words[0]
}

export class Permissions {
  private readonly rules: Set<string>
  private readonly configRules: Set<string>

  constructor(
    public mode: PermissionMode,
    rules: string[] = [],
    private readonly cwd = process.cwd(),
  ) {
    this.rules = new Set(rules)
    this.configRules = new Set(rules)
  }

  /** Edits may only be auto-allowed inside the project and outside .git. */
  private editInProject(target: string): boolean {
    const rel = relative(this.cwd, resolve(this.cwd, target))
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) return false
    return !rel.split(sep).includes('.git') && !rel.split('/').includes('.git')
  }

  /** Rules that "[a] allow for this session" would add; undefined when it must always be asked. */
  rulesFor(req: PermissionRequest): string[] | undefined {
    if (req.kind === 'edit') return this.editInProject(req.target) ? ['edit(project)'] : undefined
    if (req.kind === 'fetch') {
      try {
        return [`fetch(${new URL(req.target).hostname})`]
      } catch {
        return undefined
      }
    }
    if (req.kind === 'bash') {
      // Substitution, redirection and subshells can hide arbitrary effects behind an allowed name.
      if (/`|\$\(|[<>]|^\s*[({]/.test(req.target)) return undefined
      const segments = req.target
        .split(/&&|\|\||[;&|\n]/)
        .map((s) => s.trim())
        .filter(Boolean)
      if (!segments.length) return undefined
      if (segments.some(isAlwaysAsk)) return undefined
      return [...new Set(segments.map((s) => `bash(${commandKey(s)})`))]
    }
    if (req.kind === 'mcp') return [`mcp(${req.tool})`]
    return []
  }

  check(req: PermissionRequest): Decision {
    if (req.kind === 'read') return 'allow'
    if (this.mode === 'allowAll') return 'allow'
    if (this.mode === 'plan') return 'deny'
    // A bare kind rule ("bash", "edit") is an explicit blanket grant from config or --allowed-tools.
    if (this.rules.has(req.kind)) return 'allow'
    const needed = this.rulesFor(req)
    if (!needed) return 'ask'
    if (req.kind === 'edit' && this.mode === 'acceptEdits') return 'allow'
    return needed.every((rule) => this.rules.has(rule)) ? 'allow' : 'ask'
  }

  list(): { rule: string; source: 'config' | 'session' }[] {
    return [...this.rules].map((rule) => ({ rule, source: this.configRules.has(rule) ? 'config' : 'session' }))
  }

  /** Removes a session grant; rules from config/flags stay until the user edits them. */
  revoke(rule: string): void {
    if (!this.configRules.has(rule)) this.rules.delete(rule)
  }

  allowForSession(req: PermissionRequest): void {
    for (const rule of this.rulesFor(req) ?? []) this.rules.add(rule)
  }
}
