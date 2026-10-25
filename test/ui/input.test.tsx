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
  expect(completeFile('lihat @agent', cwd)).toBe('lihat @src/agent.ts ')
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

test('recalling a slash command from history with Up does not trap subsequent Up/Down navigation, and Esc dismisses suggestions', async () => {
  const { stdin, lastFrame } = render(<PromptInput history={['earlier prompt', '/status']} cwd="." onSubmit={() => {}} />)
  await tick()
  stdin.write('\u001B[A')
  await tick()
  expect(lastFrame()).toContain('> /status')
  stdin.write('\u001B[A')
  await tick()
  expect(lastFrame()).toContain('> earlier prompt')

  const other = render(<PromptInput history={[]} cwd="." onSubmit={() => {}} />)
  await tick()
  other.stdin.write('/mo')
  await tick()
  expect(other.lastFrame()).toContain('› /model')
  other.stdin.write('\u001B')
  await tick()
  expect(other.lastFrame()).not.toContain('› /model')
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

test('up then down restores the unsent draft text instead of clearing the input', async () => {
  const onSubmit = vi.fn()
  const { stdin, lastFrame } = render(<PromptInput history={['lama']} cwd="." onSubmit={onSubmit} />)
  await tick()
  stdin.write('draft saya')
  await tick()
  expect(lastFrame()).toContain('> draft saya')
  stdin.write('\x1b[A')
  await tick()
  expect(lastFrame()).toContain('> lama')
  stdin.write('\x1b[B')
  await tick()
  expect(lastFrame()).toContain('> draft saya')
})

test('Shift+Enter, Ctrl+J, and bracketed multi-line paste insert newlines without auto-submitting', async () => {
  const onSubmit = vi.fn()
  const { stdin, lastFrame } = render(<PromptInput history={[]} cwd="." onSubmit={onSubmit} />)
  await tick()
  stdin.write('baris1')
  await tick()
  stdin.write('\x1b[13;2u')
  await tick()
  stdin.write('baris2')
  await tick()
  stdin.write('\n')
  await tick()
  stdin.write('\x1b[200~baris3\r\nbaris4\x1b[201~')
  await tick()
  expect(onSubmit).not.toHaveBeenCalled()
  expect(lastFrame()).toContain('baris1')
  expect(lastFrame()).toContain('baris4')
  stdin.write('\r')
  await tick()
  expect(onSubmit).toHaveBeenCalledWith('baris1\nbaris2\nbaris3\nbaris4')
})

test('@file prefix shows live file suggestions, arrows select, and Tab completes the chosen file', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'bccli-at-'))
  mkdirSync(join(cwd, 'src'))
  writeFileSync(join(cwd, 'src', 'alpha.ts'), '1')
  writeFileSync(join(cwd, 'src', 'beta.ts'), '2')
  const onSubmit = vi.fn()
  const { stdin, lastFrame } = render(<PromptInput history={[]} cwd={cwd} onSubmit={onSubmit} />)
  await tick()
  stdin.write('cek @src/')
  await tick()
  expect(lastFrame()).toContain('› @src/alpha.ts')
  expect(lastFrame()).toContain('  @src/beta.ts')
  // Arrow down moves highlight to beta.ts (Ink 8 no longer forwards the mouse wheel to useInput)
  stdin.write('\x1b[B')
  await tick()
  expect(lastFrame()).toContain('› @src/beta.ts')
  stdin.write('\t')
  await tick()
  expect(lastFrame()).toContain('> cek @src/beta.ts ')
  expect(onSubmit).not.toHaveBeenCalled()
})

test('pasting a 25-line block windows EditableText around the cursor so the prompt box never overflows the viewport', async () => {
  const onSubmit = vi.fn()
  const { stdin, lastFrame } = render(<PromptInput history={[]} cwd="." onSubmit={onSubmit} />)
  await tick()
  const manyLines = Array.from({ length: 25 }, (_, i) => `BARIS_INPUT_${i}`).join('\r\n')
  stdin.write(`\x1b[200~${manyLines}\x1b[201~`)
  await tick()
  const frame = lastFrame() ?? ''
  expect(frame).toContain('BARIS_INPUT_24')
  expect(frame).not.toContain('BARIS_INPUT_0')
  stdin.write('\r')
  await tick()
  expect(onSubmit).toHaveBeenCalledWith(manyLines.replace(/\r\n/g, '\n'))
})
