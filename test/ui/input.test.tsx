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

test('terminal focus in/out reports are not typed into the prompt', async () => {
  const { stdin, lastFrame } = render(<PromptInput history={[]} cwd="." onSubmit={() => {}} />)
  await tick()
  stdin.write('\x1b[I')
  await tick()
  stdin.write('ab')
  await tick()
  stdin.write('\x1b[O')
  await tick()
  expect(lastFrame()).toContain('> ab')
  expect(lastFrame()).not.toMatch(/\[[IO]/)
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
  expect(lastFrame()).toContain('› /copy')
  stdin.write('\u001B[B')
  await tick()
  expect(lastFrame()).toContain('› /clear')
  expect(lastFrame()).not.toContain('old entry')
  stdin.write('\t')
  await tick()
  expect(lastFrame()).toContain('> /clear')
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

const LEFT = '\x1b[D'
const RIGHT = '\x1b[C'
const HOME = '\x1b[H'
const END = '\x1b[F'
const DEL = '\x1b[3~'

async function typeKeys(onSubmit: (s: string) => void, keys: string[], history: string[] = []) {
  const { stdin } = render(<PromptInput history={history} cwd="." onSubmit={onSubmit} />)
  await tick()
  for (const k of keys) {
    stdin.write(k)
    await tick()
  }
  stdin.write('\r')
  await tick()
}

test('arrows move the cursor so text can be inserted in the middle', async () => {
  const onSubmit = vi.fn()
  await typeKeys(onSubmit, ['halo dunia', ...Array(6).fill(LEFT), 'X'])
  expect(onSubmit).toHaveBeenCalledWith('haloX dunia')
})

test('backspace and delete edit around the cursor', async () => {
  const a = vi.fn()
  await typeKeys(a, ['abcdef', LEFT, LEFT, LEFT, '\x7f'])
  expect(a).toHaveBeenCalledWith('abdef')
  const b = vi.fn()
  await typeKeys(b, ['abcdef', LEFT, LEFT, LEFT, DEL])
  expect(b).toHaveBeenCalledWith('abcef')
})

test('home and end jump to the ends of the line; ctrl+left jumps a word', async () => {
  const a = vi.fn()
  await typeKeys(a, ['dunia', HOME, 'halo ', END, '!'])
  expect(a).toHaveBeenCalledWith('halo dunia!')
  const b = vi.fn()
  await typeKeys(b, ['satu dua tiga', '\x1b[1;5D', 'X'])
  expect(b).toHaveBeenCalledWith('satu dua Xtiga')
})

test('up/down walk history when the text is a single line, with the cursor anywhere', async () => {
  const onSubmit = vi.fn()
  await typeKeys(onSubmit, ['x', LEFT, '\x1b[A'], ['sebelumnya'])
  expect(onSubmit).toHaveBeenCalledWith('sebelumnya')
})
