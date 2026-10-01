import { render } from 'ink-testing-library'
import { expect, test, vi } from 'vitest'
import { Permissions } from '../src/permissions'
import { createExitPlanTool } from '../src/tools/plan'
import { PlanApproval } from '../src/ui/PlanApproval'

const ctx = { cwd: '.', signal: new AbortController().signal, readFiles: new Set<string>() }
const tick = () => new Promise((r) => setTimeout(r, 40))

test('outside plan mode exit_plan is an error', async () => {
  const tool = createExitPlanTool({ permissions: new Permissions('default'), interaction: { approvePlan: async () => 'default' } })
  expect((await tool.run({ plan: 'x' }, ctx)).isError).toBe(true)
})

test('approval switches the mode and tells the agent to start', async () => {
  const permissions = new Permissions('plan')
  const tool = createExitPlanTool({ permissions, interaction: { approvePlan: async () => 'acceptEdits' } })
  const r = await tool.run({ plan: '1. edit' }, ctx)
  expect(permissions.mode).toBe('acceptEdits')
  expect(r.output).toMatch(/Plan approved/)
})

test('rejection keeps plan mode and asks for a revision', async () => {
  const permissions = new Permissions('plan')
  const tool = createExitPlanTool({ permissions, interaction: { approvePlan: async () => 'no' } })
  const r = await tool.run({ plan: '1. edit' }, ctx)
  expect(permissions.mode).toBe('plan')
  expect(r.output).toMatch(/revise/i)
})

test('PlanApproval keys map to decisions', async () => {
  for (const [key, decision] of [['a', 'acceptEdits'], ['y', 'default'], ['n', 'no']] as const) {
    const onAnswer = vi.fn()
    const { stdin, lastFrame } = render(<PlanApproval plan={'**Rencana**\n1. ubah a.ts'} onAnswer={onAnswer} />)
    expect(lastFrame()).toContain('Rencana')
    await tick()
    stdin.write(key)
    await tick()
    expect(onAnswer).toHaveBeenCalledWith(decision)
  }
})
