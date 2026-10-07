import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { appendMemory } from '../slash/memory'
import { defineTool, type ToolContext } from './types'

export interface SaveMemoryOptions {
  /** Global store lives at <home>/BCCLI.md; project store at <cwd>/AGENTS.md. */
  home: string
  /** Called after the instruction files changed so the system prompt can be rebuilt. */
  onSaved?: () => void
}

/**
 * Lets the model persist durable facts itself (same store as /memory): project rules
 * go to AGENTS.md, cross-project preferences to the global BCCLI.md. Duplicate lines
 * are not written again.
 */
export function createSaveMemoryTool(opts: SaveMemoryOptions): ReturnType<typeof defineTool> {
  return defineTool({
    name: 'save_memory',
    description:
      'Save a durable fact, decision, or convention to the instruction files so future sessions remember it. Scope "project" (default) appends to AGENTS.md in the project; "global" appends to your personal BCCLI.md. Use for things worth remembering across sessions, not temporary task notes.',
    schema: z.object({
      content: z
        .string()
        .min(1)
        .max(500)
        .describe('One short line, without a leading bullet (it is added for you)'),
      scope: z.enum(['project', 'global']).optional().describe('project (default) or global'),
    }),
    kind: 'edit',
    target: (input) => `${input.scope ?? 'project'} memory`,
    async run(input, ctx: ToolContext) {
      const content = input.content.trim()
      if (!content) return { output: 'Memory content is empty.', isError: true }
      const file = input.scope === 'global' ? join(opts.home, 'BCCLI.md') : join(ctx.cwd, 'AGENTS.md')
      if (existsSync(file)) {
        const lines = readFileSync(file, 'utf8').split('\n')
        if (lines.some((line) => line.trim() === `- ${content}`)) {
          return { output: `Already saved to ${file}.` }
        }
      }
      appendMemory(file, content)
      opts.onSaved?.()
      return { output: `Saved to ${file}.` }
    },
  })
}
