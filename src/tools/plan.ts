import { z } from 'zod'
import type { Permissions } from '../permissions'
import { defineTool, type Tool } from './types'
import { t } from '../i18n'

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
    target: () => t('plan'),
    async run(input) {
      if (opts.permissions.mode !== 'plan') return { output: 'exit_plan is only used in plan mode.', isError: true }
      const decision = await opts.interaction.approvePlan(input.plan)
      if (decision === 'no') {
        return { output: 'The user has not approved yet. Ask what needs to change, revise the plan, then call exit_plan again.' }
      }
      opts.permissions.mode = decision
      return { output: `Plan approved. The mode is now ${decision}. Start carrying out the plan now.` }
    },
  }) as Tool
}
