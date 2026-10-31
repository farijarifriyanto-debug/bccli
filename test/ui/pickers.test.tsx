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

test('model picker opens on a search field with the visible/total count', () => {
  const frame = render(<ModelPicker groups={groups} current="bc-cloud/glm-5.3-flash" onPick={() => {}} />).lastFrame()!
  expect(frame).toContain('Pilih model')
  expect(frame).toMatch(/cari: ?▌/)
  expect(frame).toMatch(/ketik nama model atau provider/)
  // 2 from BotConnector Cloud + 301 from OpenRouter; the provider that failed to answer has no models to count.
  expect(frame).toContain('303/303 model')
})

test('search matches the provider name, so typing a provider lists just its models', async () => {
  const { stdin, lastFrame } = render(<ModelPicker groups={groups} current="bc-cloud/glm-5.3-flash" onPick={() => {}} />)
  await tick()
  stdin.write('openrouter')
  await tick()
  expect(lastFrame()).toMatch(/── OpenRouter/)
  expect(lastFrame()).toContain('vendor/model-0')
  expect(lastFrame()).not.toContain('glm-5.3-flash')
  expect(lastFrame()).toContain('301/303 model')
})

test('a search with no hits says so, counts zero, and backspace restores the list', async () => {
  const { stdin, lastFrame } = render(<ModelPicker groups={groups} current="bc-cloud/glm-5.3-flash" onPick={() => {}} />)
  await tick()
  stdin.write('zzz')
  await tick()
  expect(lastFrame()).toMatch(/Tidak ada model yang cocok|No matching models/)
  expect(lastFrame()).toContain('0/303 model')
  for (let i = 0; i < 3; i++) {
    stdin.write('\u007F')
    await tick()
  }
  expect(lastFrame()).toContain('303/303 model')
  expect(lastFrame()).not.toMatch(/Tidak ada model yang cocok|No matching models/)
})

test('enter picks the first match of a search', async () => {
  const onPick = vi.fn()
  const { stdin } = render(<ModelPicker groups={groups} current="" onPick={onPick} />)
  await tick()
  stdin.write('deepseek')
  await tick()
  stdin.write('\r')
  await tick()
  expect(onPick).toHaveBeenCalledWith('bc-cloud/deepseek-v4-flash')
})

test('providers that share a display name are told apart by their id', () => {
  const twins = [
    { providerId: 'gmi', providerName: 'GMI Cloud', models: ['google/gemini-3.5-flash'] },
    { providerId: 'gmicloud', providerName: 'GMI Cloud', models: ['google/gemini-3.5-flash'] },
  ]
  const frame = render(<ModelPicker groups={twins} current="" onPick={() => {}} />).lastFrame()!
  expect(frame).toContain('── GMI Cloud (gmi)')
  expect(frame).toContain('── GMI Cloud (gmicloud)')
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

test('model picker ignores SGR mouse escape sequences in filter', async () => {
  const { stdin, lastFrame } = render(<ModelPicker groups={groups} current="bc-cloud/glm-5.3-flash" onPick={() => {}} />)
  await tick()
  stdin.write('\x1b[<0;32;14M')
  await tick()
  expect(lastFrame()).toContain('glm-5.3-flash')
  expect(lastFrame()).not.toContain('[<0;32;14M')
})

test('model picker and provider menu scroll with arrow keys/PageDown and leave mouse wheel to the terminal', async () => {
  const { stdin, lastFrame } = render(<ModelPicker groups={groups} current="bc-cloud/glm-5.3-flash" onPick={() => {}} />)
  await tick()
  expect(lastFrame()).toContain('› glm-5.3-flash')
  // Ink 8 drops mouse sequences before useInput: the wheel must not move the cursor.
  stdin.write('\x1b[<65;10;10M')
  await tick()
  expect(lastFrame()).toContain('› glm-5.3-flash')
  stdin.write('\x1b[B')
  await tick()
  expect(lastFrame()).toContain('› deepseek-v4-flash')
  stdin.write('\x1b[A')
  await tick()
  expect(lastFrame()).toContain('› glm-5.3-flash')
  stdin.write('\x1b[6~')
  await tick()
  expect(lastFrame()).toContain('› vendor/model-')

  const onPickProvider = vi.fn()
  const p = render(
    <ProviderMenu
      entries={[
        { id: 'bc-cloud', name: 'BotConnector Cloud', ready: true, baseURL: 'https://api.botconnector.id/v1' },
        { id: 'groq', name: 'Groq', ready: false, baseURL: 'https://api.groq.com/openai/v1' },
      ]}
      onPick={onPickProvider}
    />,
  )
  await tick()
  p.stdin.write('\x1b[B')
  await tick()
  p.stdin.write('\r')
  await tick()
  expect(onPickProvider).toHaveBeenCalledWith('groq')
})
