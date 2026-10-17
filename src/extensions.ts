import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'

export interface SkillDef {
  name: string
  description: string
  dir: string
  file: string
}
export interface CommandDef {
  name: string
  description?: string
  argumentHint?: string
  body: string
}
export interface AgentDef {
  name: string
  description: string
  tools?: string[]
  model?: string
  prompt: string
  maxSteps?: number
  /** Run this agent concurrently with sibling task calls even when its tools can write. */
  parallel?: boolean
}
export interface ExtensionRoots {
  cwd: string
  home: string
  userHome: string
}

export function parseFrontmatter(text: string): { data: Record<string, string | string[]>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (!match) return { data: {}, body: text }
  const data: Record<string, string | string[]> = {}
  for (const line of match[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    if (!kv) continue
    let value = kv[2].trim()
    if (value.startsWith('[') && value.endsWith(']')) {
      data[kv[1]] = value
        .slice(1, -1)
        .split(',')
        .map((s) => s.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean)
      continue
    }
    if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1)
    data[kv[1]] = value
  }
  return { data, body: text.slice(match[0].length) }
}

const str = (v: string | string[] | undefined) => (Array.isArray(v) ? v.join(', ') : v)

// Later directories override earlier ones by name: global before project, .claude before .bccli.
function dirs(r: ExtensionRoots, kind: string): string[] {
  return [join(r.userHome, '.claude', kind), join(r.home, kind), join(r.cwd, '.claude', kind), join(r.cwd, '.bccli', kind)]
}

function list(dir: string): string[] {
  try {
    return readdirSync(dir).sort()
  } catch {
    return []
  }
}

export function loadSkills(r: ExtensionRoots): SkillDef[] {
  const byName = new Map<string, SkillDef>()
  for (const dir of dirs(r, 'skills')) {
    for (const entry of list(dir)) {
      const file = join(dir, entry, 'SKILL.md')
      if (!existsSync(file)) continue
      const { data } = parseFrontmatter(readFileSync(file, 'utf8'))
      const name = str(data.name) || entry
      byName.set(name, { name, description: str(data.description) ?? '', dir: join(dir, entry), file })
    }
  }
  return [...byName.values()]
}

export function loadCommands(r: ExtensionRoots): CommandDef[] {
  const byName = new Map<string, CommandDef>()
  for (const dir of dirs(r, 'commands')) {
    for (const entry of list(dir)) {
      const file = join(dir, entry)
      if (!entry.endsWith('.md') || !statSync(file).isFile()) continue
      const { data, body } = parseFrontmatter(readFileSync(file, 'utf8'))
      const def: CommandDef = { name: basename(entry, '.md'), body: body.trim() }
      if (data.description) def.description = str(data.description)
      if (data['argument-hint']) def.argumentHint = str(data['argument-hint'])
      byName.set(def.name, def)
    }
  }
  return [...byName.values()]
}

export function loadAgentDefs(r: ExtensionRoots): AgentDef[] {
  const byName = new Map<string, AgentDef>()
  for (const dir of dirs(r, 'agents')) {
    for (const entry of list(dir)) {
      if (!entry.endsWith('.md')) continue
      const { data, body } = parseFrontmatter(readFileSync(join(dir, entry), 'utf8'))
      const name = str(data.name) || basename(entry, '.md')
      const def: AgentDef = { name, description: str(data.description) ?? '', prompt: body.trim() }
      if (data.tools)
        def.tools = Array.isArray(data.tools)
          ? data.tools
          : String(data.tools)
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean)
      if (data.model) def.model = str(data.model)
      // Frontmatter values are raw strings; only an explicit `parallel: true` opts in.
      if (str(data.parallel) === 'true') def.parallel = true
      const rawMaxSteps = str(data.maxSteps ?? data['max-steps'])
      if (rawMaxSteps) {
        const maxSteps = Number(rawMaxSteps)
        if (Number.isFinite(maxSteps) && maxSteps > 0) def.maxSteps = Math.max(1, Math.floor(maxSteps))
      }
      byName.set(name, def)
    }
  }
  return [...byName.values()]
}
