import type { CommandDef } from './extensions'

/** Descriptions are English keys; wrap them in t() when showing them. */
export const SLASH_COMMANDS = [
  { name: 'help', description: 'list of commands and shortcuts' },
  { name: 'model', description: 'change model' },
  { name: 'reasoning', description: 'set reasoning: auto/off/low/medium/high/max' },
  { name: 'provider', description: 'add/choose an AI provider' },
  { name: 'mcp', description: 'install/manage MCP servers' },
  { name: 'new', description: 'new session (the old one stays saved)' },
  { name: 'resume', description: 'continue another session in this folder' },
  { name: 'session', description: 'info about this session' },
  { name: 'status', description: 'version, model, permission mode, MCP, context' },
  { name: 'permissions', description: 'view/revoke permissions' },
  { name: 'undo', description: 'undo the file edits of the last turn' },
  { name: 'diff', description: 'git diff of the project' },
  { name: 'copy', description: 'copy the last answer' },
  { name: 'export', description: 'save the conversation as markdown' },
  { name: 'memory', description: 'project instructions (/memory <text>, /memory global <text>)' },
  { name: 'init', description: 'create/update AGENTS.md for this project' },
  { name: 'agents', description: 'list subagents' },
  { name: 'skills', description: 'list skills and custom commands' },
  { name: 'doctor', description: 'check installation health' },
  { name: 'login', description: 'save the API key of the current provider' },
  { name: 'logout', description: 'delete the API key of the current provider' },
  { name: 'language', description: 'set the interface language: en/id' },
  { name: 'clear', description: 'start a new conversation' },
  { name: 'compact', description: 'summarize the conversation' },
  { name: 'cost', description: 'token usage of this session' },
  { name: 'exit', description: 'quit' },
]

export function parseSlash(text: string): { name: string; args: string } | undefined {
  if (!text.startsWith('/')) return undefined
  const [name, ...rest] = text.slice(1).trim().split(/\s+/)
  return { name: name.toLowerCase(), args: rest.join(' ') }
}

export function expandCommand(def: CommandDef, args: string): string {
  if (def.body.includes('$ARGUMENTS')) return def.body.replaceAll('$ARGUMENTS', args)
  return args ? `${def.body}\n\n${args}` : def.body
}
