import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { SkillDef } from './extensions'

const FILES = ['AGENTS.md', 'BCCLI.md']

function readIf(path: string): string | undefined {
  try {
    return existsSync(path) ? readFileSync(path, 'utf8').trim() : undefined
  } catch {
    return undefined
  }
}

export function loadInstructions(cwd: string, home: string): string {
  const dirs: string[] = []
  for (let dir = cwd; ; dir = dirname(dir)) {
    dirs.unshift(dir)
    if (dirname(dir) === dir) break
  }
  const parts: string[] = []
  const global = readIf(join(home, 'BCCLI.md'))
  if (global) parts.push(`# ${join(home, 'BCCLI.md')}\n${global}`)
  for (const dir of dirs) {
    for (const name of FILES) {
      const text = readIf(join(dir, name))
      if (text) parts.push(`# ${join(dir, name)}\n${text}`)
    }
  }
  return parts.join('\n\n')
}

function isGitRepo(cwd: string): boolean {
  for (let dir = cwd; ; dir = dirname(dir)) {
    if (existsSync(join(dir, '.git'))) return true
    if (dirname(dir) === dir) return false
  }
}

export function buildSystemPrompt(opts: { cwd: string; home: string; model: string; date?: string; platform?: string; skills?: SkillDef[] }): string {
  const instructions = loadInstructions(opts.cwd, opts.home)
  const skills = (opts.skills ?? []).slice(0, 50)
  const skillText = skills.length
    ? `\n\nSkills (load one with the skill tool when it matches the task):\n${skills.map((s) => `- ${s.name}: ${s.description.slice(0, 200)}`).join('\n')}`
    : ''
  return `You are BCCLI, a coding agent by BotConnector running in the user's terminal. You help with software engineering tasks by reading code, editing files, and running commands with the tools provided.

How to work:
- Understand before changing: read the relevant files and search the codebase first. Never guess file contents.
- Always read a file before editing it. Make the smallest correct change; match the existing style.
- Verify your work: run the tests, build or the command that proves the change works, and report the real result.
- The user must approve edits and commands. If they decline, ask what they want instead of retrying.
- Be concise. Reply in the user's language. No preamble; lead with the answer or the action.
- Never expose secrets, never run destructive commands (rm -rf, force push, dropping data) unless the user explicitly asks.

Environment:
- Working directory: ${opts.cwd}
- Git repository: ${isGitRepo(opts.cwd) ? 'yes' : 'no'}
- Platform: ${opts.platform ?? process.platform}
- Date: ${opts.date ?? new Date().toISOString().slice(0, 10)}
- Model: ${opts.model}${skillText}${instructions ? `\n\nProject and user instructions (follow them):\n\n${instructions}` : ''}`
}
