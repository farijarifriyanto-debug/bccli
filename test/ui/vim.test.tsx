import { render } from 'ink-testing-library'
import { describe, expect, it } from 'vitest'
import { PromptInput } from '../../src/ui/PromptInput'

const noop = () => {}
const tick = () => new Promise((r) => setTimeout(r, 30))
const ESC = String.fromCharCode(27)

describe('vim prompt input', () => {
  it('starts in insert mode and shows the NORMAL indicator after esc', async () => {
    const { lastFrame, stdin } = render(<PromptInput history={[]} cwd="." onSubmit={noop} vim />)
    stdin.write('hi')
    await tick()
    expect(lastFrame()).toContain('hi')
    expect(lastFrame()).not.toContain('NORMAL')
    stdin.write(ESC)
    await tick()
    expect(lastFrame()).toContain('NORMAL')
    // in normal mode, typing a letter does not insert it
    stdin.write('z')
    await tick()
    const frame = lastFrame() ?? ''
    expect(frame).toContain('NORMAL')
    expect(frame).not.toContain('hiz')
  })

  it('x in normal mode deletes a character', async () => {
    const { lastFrame, stdin } = render(<PromptInput history={[]} cwd="." onSubmit={noop} vim />)
    stdin.write('ab')
    await tick()
    stdin.write(ESC)
    await tick()
    stdin.write('x')
    await tick()
    const frame = lastFrame() ?? ''
    expect(frame).toContain('a')
    expect(frame).not.toContain('ab')
  })

  it('i returns to insert mode and typing works again', async () => {
    const { lastFrame, stdin } = render(<PromptInput history={[]} cwd="." onSubmit={noop} vim />)
    stdin.write('ab')
    await tick()
    stdin.write(ESC)
    await tick()
    stdin.write('i')
    await tick()
    expect(lastFrame()).not.toContain('NORMAL')
    stdin.write('c')
    await tick()
    // esc clamps the cursor onto the last character, so "i" inserts before it (real vim behavior)
    expect(lastFrame()).toContain('acb')
  })

  it('without the vim prop, esc does not show NORMAL', async () => {
    const { lastFrame, stdin } = render(<PromptInput history={[]} cwd="." onSubmit={noop} />)
    stdin.write('hi')
    await tick()
    stdin.write(ESC)
    await tick()
    expect(lastFrame()).not.toContain('NORMAL')
  })

  it('submitting resets to insert mode', async () => {
    const submitted: string[] = []
    const { lastFrame, stdin } = render(
      <PromptInput
        history={[]}
        cwd="."
        onSubmit={(v) => submitted.push(v)}
        vim
      />,
    )
    stdin.write('go')
    await tick()
    stdin.write(ESC)
    await tick()
    expect(lastFrame()).toContain('NORMAL')
    stdin.write('\r')
    await tick()
    expect(submitted).toEqual(['go'])
    stdin.write('x')
    await tick()
    expect(lastFrame()).toContain('x')
  })
})
