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
  { name: 'redo', description: 're-apply the file edits that /undo just reverted' },
  { name: 'rewind', description: 'step back turns: conversation and file edits (/rewind 2)' },
  { name: 'diff', description: 'git diff of the project' },
  { name: 'worktree', description: 'list git worktrees; create one with bccli -w <name>' },
  { name: 'pr', description: 'review a pull request (/pr <n|url|branch>)' },
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
  { name: 'tasks', description: 'list background tasks' },
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

/**
 * /pr: the model runs gh itself (installed on PATH), so this is a prompt, not a fetch.
 * Empty selector = the PR of the current branch, falling back to a branch diff.
 */
export function prReviewPrompt(selector: string): string {
  const target = selector.trim()
  const refs = target
    ? `Use "${target}" as the PR selector: run gh pr view ${target} --json url,title,body,baseRefName,headRefName,files,additions,deletions and gh pr diff ${target}.`
    : "Start with `gh pr view --json url,title,baseRefName,headRefName` for the PR of the current branch, then fetch the change with `gh pr diff`. If the branch has no open PR, review its changes against the default branch instead: find the default branch (`gh repo view --json defaultBranchRef` or `git remote show origin`), then `git diff origin/<default-branch>...HEAD`."
  return `Review this pull request like a senior reviewer.
${refs}
Read the changed files in the repository when the diff alone is not enough to judge the change.
Never change the repository state while reviewing: do not check out, switch, create, delete, merge or rebase branches, do not reset, stash, commit, pull, or fetch into the working tree, and do not write, edit or delete any file. The review is strictly read-only. To read a file as it exists in another revision, use read-only commands such as \`git show <ref>:<path>\` or \`gh pr diff\`.
Write the review as: a 2-3 sentence summary; concrete problems (bugs, security, race conditions, error handling), each with file:line and why it matters; missing or weak tests; smaller style/nit issues; then a final verdict — approve, request changes, or comment — with the single most important reason.`
}
