import { render } from 'ink-testing-library'
import { expect, test, vi } from 'vitest'
import { parseSlash } from '../../src/commands'
import { DiffView } from '../../src/ui/DiffView'
import { Markdown } from '../../src/ui/Markdown'
import { PermissionPrompt } from '../../src/ui/PermissionPrompt'
import { StatusBar } from '../../src/ui/StatusBar'
import { ToolBlock } from '../../src/ui/ToolBlock'

const tick = () => new Promise((r) => setTimeout(r, 30))

test('permission prompt answers y / a / n', async () => {
  for (const [key, answer] of [['y', 'yes'], ['a', 'session'], ['n', 'no']] as const) {
    const onAnswer = vi.fn()
    const { stdin, lastFrame } = render(
      <PermissionPrompt request={{ tool: 'bash', kind: 'bash', target: 'npm test', sessionRules: ['bash(npm test)'] }} onAnswer={onAnswer} />,
    )
    expect(lastFrame()).toContain('npm test')
    expect(lastFrame()).toContain('[a] ya sesi ini untuk bash(npm test)')
    await tick()
    stdin.write(key)
    await tick()
    expect(onAnswer).toHaveBeenCalledWith(answer)
  }
})

test('without session rules there is no [a] option and "a" does nothing', async () => {
  const onAnswer = vi.fn()
  const { stdin, lastFrame } = render(
    <PermissionPrompt request={{ tool: 'bash', kind: 'bash', target: 'ls > out' }} onAnswer={onAnswer} />,
  )
  expect(lastFrame()).not.toContain('[a]')
  await tick()
  stdin.write('a')
  await tick()
  expect(onAnswer).not.toHaveBeenCalled()
})

test('permission prompt shows the edit preview', () => {
  const { lastFrame } = render(
    <PermissionPrompt request={{ tool: 'edit', kind: 'edit', target: 'a.ts', preview: '    1 - old\n    1 + new' }} onAnswer={() => {}} />,
  )
  expect(lastFrame()).toContain('Izinkan edit a.ts?')
  expect(lastFrame()).toContain('+ new')
})

test('status bar shows mode and warns loudly in allowAll', () => {
  expect(render(<StatusBar mode="default" tokens={12345} busy={false} />).lastFrame()).toContain('12k token')
  expect(render(<StatusBar mode="allowAll" tokens={0} busy={false} />).lastFrame()).toContain('⏵⏵ allow all')
})

test('tool block truncates long output with a ctrl+o hint', () => {
  const output = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n')
  const frame = render(<ToolBlock tool="bash" target="ls" output={output} done />).lastFrame()!
  expect(frame).toContain('⎿ Bash  ls')
  expect(frame).toContain('line 4')
  expect(frame).not.toContain('line 5')
  expect(frame).toContain('15 baris lagi (ctrl+o)')
})

test('diff and markdown render text', () => {
  expect(render(<DiffView diff={'    1 - a\n    1 + b'} />).lastFrame()).toContain('+ b')
  const md = render(<Markdown text={'**tebal** dan `kode`\n```\nx = 1\n```'} />).lastFrame()!
  expect(md).toContain('tebal dan kode')
  expect(md).toContain('x = 1')
  expect(md).not.toContain('```')
})

test('parseSlash', () => {
  expect(parseSlash('/model bc-cloud/x')).toEqual({ name: 'model', args: 'bc-cloud/x' })
  expect(parseSlash('hello')).toBeUndefined()
})

test('task block shows nested subagent tools and the summary', () => {
  const frame = render(
    <ToolBlock
      tool="task"
      target="[explore] cari login"
      output="login di auth.ts:1"
      display="2 langkah · 1k token"
      done
      sub={[
        { id: 'a', tool: 'grep', target: 'login', done: true },
        { id: 'b', tool: 'read', target: 'auth.ts', done: true },
      ]}
    />,
  ).lastFrame()!
  expect(frame).toContain('⎿ Task  [explore] cari login')
  expect(frame).toMatch(/ {5}⎿ Grep {2}login/)
  expect(frame).toContain('✓ selesai · 2 langkah · 1k token')
})

test('permission prompt names the subagent', () => {
  const frame = render(
    <PermissionPrompt request={{ tool: 'edit', kind: 'edit', target: 'a.ts', agent: 'general', sessionRules: ['edit(project)'] }} onAnswer={() => {}} />,
  ).lastFrame()!
  expect(frame).toContain('[general] Izinkan edit a.ts?')
})
