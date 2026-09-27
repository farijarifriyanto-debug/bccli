import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { render } from 'ink-testing-library'
import { expect, test, vi } from 'vitest'
import { completeFile } from '../../src/ui/complete'
import { PromptInput } from '../../src/ui/PromptInput'

const tick = () => new Promise((r) => setTimeout(r, 30))

test('typing and enter submits trimmed text, then clears', async () => {
  const onSubmit = vi.fn()
  const { stdin, lastFrame } = render(<PromptInput history={[]} cwd="." onSubmit={onSubmit} />)
  await tick()
  stdin.write('halo ')
  await tick()
  expect(lastFrame()).toContain('> halo')
  stdin.write('\r')
  await tick()
  expect(onSubmit).toHaveBeenCalledWith('halo')
  expect(lastFrame()).not.toContain('halo')
})

test('backslash + enter inserts a newline', async () => {
  const onSubmit = vi.fn()
  const { stdin, lastFrame } = render(<PromptInput history={[]} cwd="." onSubmit={onSubmit} />)
  await tick()
  stdin.write('a\\')
  await tick()
  stdin.write('\r')
  await tick()
  stdin.write('b')
  await tick()
  expect(onSubmit).not.toHaveBeenCalled()
  expect(lastFrame()).toContain('b')
})

test('up arrow recalls history; slash shows suggestions', async () => {
  const { stdin, lastFrame } = render(<PromptInput history={['pertama', 'kedua']} cwd="." onSubmit={() => {}} />)
  await tick()
  stdin.write('\u001B[A')
  await tick()
  expect(lastFrame()).toContain('> kedua')
  const other = render(<PromptInput history={[]} cwd="." onSubmit={() => {}} />)
  await tick()
  other.stdin.write('/mo')
  await tick()
  expect(other.lastFrame()).toContain('/model')
})

test('completeFile completes the last @token', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'bccli-c-'))
  mkdirSync(join(cwd, 'src'))
  writeFileSync(join(cwd, 'src', 'agent.ts'), '')
  expect(completeFile('lihat @src/ag', cwd)).toBe('lihat @src/agent.ts ')
  expect(completeFile('tanpa token', cwd)).toBe('tanpa token')
})

test('typing a slash prefix highlights the first match and Enter runs it', async () => {
  const onSubmit = vi.fn()
  const { stdin, lastFrame } = render(<PromptInput history={[]} cwd="." onSubmit={onSubmit} />)
  await tick()
  stdin.write('/pro')
  await tick()
  expect(lastFrame()).toContain('› /provider')
  stdin.write('\r')
  await tick()
  expect(onSubmit).toHaveBeenCalledWith('/provider')
})

test('arrows move the highlight among suggestions; Tab completes without running', async () => {
  const onSubmit = vi.fn()
  const { stdin, lastFrame } = render(<PromptInput history={['old entry']} cwd="." onSubmit={onSubmit} />)
  await tick()
  stdin.write('/c')
  await tick()
  expect(lastFrame()).toContain('› /clear')
  stdin.write('\u001B[B')
  await tick()
  expect(lastFrame()).toContain('› /compact')
  expect(lastFrame()).not.toContain('old entry')
  stdin.write('\t')
  await tick()
  expect(lastFrame()).toContain('> /compact')
  expect(onSubmit).not.toHaveBeenCalled()
})

test('once arguments are typed, Enter sends the text as is', async () => {
  const onSubmit = vi.fn()
  const { stdin } = render(<PromptInput history={[]} cwd="." onSubmit={onSubmit} />)
  await tick()
  stdin.write('/model qwen')
  await tick()
  stdin.write('\r')
  await tick()
  expect(onSubmit).toHaveBeenCalledWith('/model qwen')
})
