import { z } from 'zod'
import type { Permissions } from '../permissions'
import { defineTool, type Tool } from './types'

export type PlanDecision = 'acceptEdits' | 'default' | 'allowAll' | 'no'
export interface Interaction {
  approvePlan(plan: string): Promise<PlanDecision>
}

export function createExitPlanTool(opts: { permissions: Permissions; interaction: Interaction }): Tool {
  return defineTool({
    name: 'exit_plan',
    description: 'Plan mode only: present the finished plan to the user for approval. If approved you may start implementing it.',
    schema: z.object({ plan: z.string().describe('The plan, in markdown') }),
    kind: 'read',
    target: () => 'rencana',
    async run(input) {
      if (opts.permissions.mode !== 'plan') return { output: 'exit_plan hanya dipakai di mode plan.', isError: true }
      const decision = await opts.interaction.approvePlan(input.plan)
      if (decision === 'no') {
        return { output: 'User belum menyetujui. Tanyakan apa yang perlu diperbaiki, perbaiki rencananya, lalu panggil exit_plan lagi.' }
      }
      opts.permissions.mode = decision
      return { output: `Rencana disetujui. Mode sekarang ${decision}. Mulai kerjakan rencananya sekarang.` }
    },
  }) as Tool
}
