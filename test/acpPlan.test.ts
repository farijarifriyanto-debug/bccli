import { expect, test } from 'vitest'
import { planDecisionFrom, runtimeAgent } from '../src/acp'
import type { Runtime } from '../src/setup'

test('plan approval maps the editor answer onto a permission mode', () => {
  expect(planDecisionFrom('yes')).toBe('default')
  expect(planDecisionFrom('session')).toBe('acceptEdits')
  // A plan answer never turns on the blanket mode: allowAll stays an explicit choice.
  expect(planDecisionFrom('all')).toBe('default')
  expect(planDecisionFrom('no')).toBe('no')
})

test('ACP asks the editor before leaving plan mode instead of always denying', async () => {
  let decision: string | undefined
  // Stands in for exit_plan, which calls interaction.approvePlan in the real tool.
  const interaction = {
    approvePlan: async (_plan: string): Promise<'acceptEdits' | 'default' | 'allowAll' | 'no'> => 'no',
  }
  const rt = {
    interaction,
    agent: {
      askPermission: async () => 'no' as const,
      onEvent: () => {},
      run: async () => {
        decision = await interaction.approvePlan('PLAN BODY')
      },
    },
  }
  const agent = runtimeAgent('/work', false, { createRuntime: () => rt as unknown as Runtime })
  const asked: Array<{ tool?: string; preview?: string }> = []

  await agent.run('go', () => {}, new AbortController().signal, {
    toolStart: () => {},
    toolEnd: () => {},
    askPermission: async (req) => {
      asked.push(req)
      return 'session'
    },
  })

  expect(asked).toHaveLength(1)
  expect(asked[0]).toMatchObject({ tool: 'exit_plan', preview: 'PLAN BODY' })
  expect(decision).toBe('acceptEdits')
})
