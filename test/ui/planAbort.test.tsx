import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { render } from 'ink-testing-library'
import { expect, test } from 'vitest'
import { parseCliArgs } from '../../src/args'
import type { Completion, Provider } from '../../src/provider'
import { createRuntime } from '../../src/setup'
import { App } from '../../src/ui/App'

const wait = (ms = 60) => new Promise((r) => setTimeout(r, ms))
async function waitFor(check: () => boolean, timeoutMs = 3000) {
  const end = Date.now() + timeoutMs
  while (!check() && Date.now() < end) await wait(20)
  expect(check()).toBe(true)
}

function scripted(steps: Completion[]): Provider {
  return {
    async chat(req) {
      const next = steps.shift()!
      if (next.text) req.onText?.(next.text)
      return next
    },
    async listModels() {
      return ['glm-5.3-flash']
    },
  }
}

function makeRuntime(steps: Completion[]) {
  const cwd = mkdtempSync(join(tmpdir(), 'bccli-planapp-'))
  writeFileSync(join(cwd, 'a.txt'), 'x\n')
  const env = { BCCLI_HOME: mkdtempSync(join(tmpdir(), 'bccli-planapph-')), BOTCONNECTOR_API_KEY: 'k' }
  return createRuntime({ cwd, args: parseCliArgs([]), env, provider: scripted(steps), userHome: mkdtempSync(join(tmpdir(), 'bccli-planappu-')) })
}

test('Esc while the plan-approval dialog is open settles the pending approval', async () => {
  const rt = makeRuntime([
    { text: '', toolCalls: [{ id: '1', name: 'exit_plan', arguments: '{"plan":"1. do the thing"}' }] },
    { text: 'ok', toolCalls: [] },
  ])
  rt.agent.permissions.mode = 'plan'
  const { stdin, frames } = render(<App runtime={rt} version="test" />)
  await wait()
  // Observe the approval promise that exit_plan will await (wired before the turn starts).
  let settled: string | undefined
  const effectApprove = rt.interaction.approvePlan.bind(rt.interaction)
  rt.interaction.approvePlan = (plan) => {
    const promise = effectApprove(plan)
    void promise.then(
      (d) => {
        settled = d
      },
      (error: unknown) => {
        settled = `rejected:${String(error)}`
      },
    )
    return promise
  }
  stdin.write('make a plan')
  await wait()
  stdin.write('\r')
  await waitFor(() => (frames.at(-1) ?? '').includes('Rencana dari agent'))
  stdin.write(String.fromCharCode(27))
  await waitFor(() => !(frames.at(-1) ?? '').includes('Rencana dari agent'))
  await wait(100)
  // The pending exit_plan promise must not be left hanging after the abort.
  expect(settled).toBeDefined()
  // And the UI must be usable again (not locked behind a dialog that never resolved).
  stdin.write('next prompt')
  await wait()
  expect(frames.at(-1)).toContain('next prompt')
})
