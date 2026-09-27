import { render } from 'ink-testing-library'
import { expect, test, vi } from 'vitest'
import { LinePrompt } from '../../src/ui/LinePrompt'
import { ModelPicker } from '../../src/ui/ModelPicker'
import { ProviderMenu } from '../../src/ui/ProviderMenu'

const tick = () => new Promise((r) => setTimeout(r, 40))
const groups = [
  { providerId: 'bc-cloud', providerName: 'BotConnector Cloud', models: ['glm-5.3-flash', 'deepseek-v4-flash'] },
  { providerId: 'openrouter', providerName: 'OpenRouter', models: Array.from({ length: 300 }, (_, i) => `vendor/model-${i}`).concat(['qwen/qwen3-coder']) },
  { providerId: 'groq', providerName: 'Groq', models: [], error: 'tidak bisa dihubungi' },
]

test('model picker groups by provider and marks unreachable ones', () => {
  const frame = render(<ModelPicker groups={groups} current="bc-cloud/glm-5.3-flash" onPick={() => {}} />).lastFrame()!
  expect(frame).toContain('BotConnector Cloud')
  expect(frame).toContain('glm-5.3-flash  (aktif)')
  expect(frame).toContain('Groq — tidak bisa dihubungi')
})

test('typing filters across providers; enter picks provider/model', async () => {
  const onPick = vi.fn()
  const { stdin, lastFrame } = render(<ModelPicker groups={groups} current="bc-cloud/glm-5.3-flash" onPick={onPick} />)
  await tick()
  stdin.write('qwen3')
  await tick()
  expect(lastFrame()).toContain('qwen/qwen3-coder')
  expect(lastFrame()).not.toContain('glm-5.3-flash')
  stdin.write('\r')
  await tick()
  expect(onPick).toHaveBeenCalledWith('openrouter/qwen/qwen3-coder')
})

test('provider menu shows readiness and offers custom', async () => {
  const onPick = vi.fn()
  const { stdin, lastFrame } = render(
    <ProviderMenu
      entries={[
        { id: 'bc-cloud', name: 'BotConnector Cloud', ready: true, baseURL: 'https://api.botconnector.id/v1' },
        { id: 'groq', name: 'Groq', ready: false, baseURL: 'https://api.groq.com/openai/v1' },
      ]}
      onPick={onPick}
    />,
  )
  expect(lastFrame()).toMatch(/✓ BotConnector Cloud/)
  expect(lastFrame()).toMatch(/○ Groq/)
  expect(lastFrame()).toContain('Custom…')
  await tick()
  stdin.write('\u001B[B')
  await tick()
  stdin.write('\r')
  await tick()
  expect(onPick).toHaveBeenCalledWith('groq')
})

test('line prompt masks secrets', async () => {
  const onSubmit = vi.fn()
  const { stdin, lastFrame } = render(<LinePrompt label="API key" mask onSubmit={onSubmit} onCancel={() => {}} />)
  await tick()
  stdin.write('sk-secret')
  await tick()
  expect(lastFrame()).not.toContain('sk-secret')
  expect(lastFrame()).toContain('•••')
  stdin.write('\r')
  await tick()
  expect(onSubmit).toHaveBeenCalledWith('sk-secret')
})
