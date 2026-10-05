import type { AgentDef } from './extensions'

export const EXPLORE_PROMPT =
  'You are a read-only research agent working for another agent. Search and read the codebase to answer the request. You cannot edit files or run commands. Reply with a concise report: the answer, the relevant file paths with line numbers, and nothing else.'
export const GENERAL_PROMPT =
  'You are an agent handling a delegated task for another agent. Complete the task end to end with the tools you have, verify the result, and reply with a short report of what you did and what you found.'

export const BUILTIN_AGENTS: AgentDef[] = [
  {
    name: 'explore',
    description: 'Read-only: search and read code to answer a question (fast, safe, can run in parallel).',
    tools: ['read', 'grep', 'glob'],
    prompt: EXPLORE_PROMPT,
  },
  {
    name: 'general',
    description: 'Full tools: carry out a self-contained sub-task (edits and commands still need user permission).',
    prompt: GENERAL_PROMPT,
  },
]
