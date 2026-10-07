import { z } from 'zod'
import { buildRepoMapSync } from '../repomap'
import { defineTool } from './types'

export function createRepoMapTool() {
  return defineTool({
    name: 'repo_map',
    description:
      'Show a map of this repository: code files (node_modules/.git excluded) with their top-level functions, classes and types. Use it to orient yourself in an unfamiliar repo before searching or reading files.',
    schema: z.object({}),
    kind: 'read',
    target: () => '(repo)',
    programmaticSafe: true,
    run: async (_input, ctx) => ({ output: buildRepoMapSync(ctx.cwd) || '(no code files found)' }),
  })
}
