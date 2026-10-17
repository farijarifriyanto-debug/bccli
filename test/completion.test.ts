import { expect, test } from 'vitest'
import { completionScript, runCompletionCommand, SHELLS } from '../src/completion'
import { parseCliArgs } from '../src/args'

test('completion is a subcommand with sub-args', () => {
  expect(parseCliArgs(['completion', 'bash'])).toMatchObject({ command: 'completion', subArgs: ['bash'] })
})

test('SHELLS lists the four supported shells', () => {
  expect(SHELLS).toEqual(['bash', 'zsh', 'fish', 'powershell'])
})

test('each shell script mentions bccli and core subcommands', () => {
  for (const shell of SHELLS) {
    const script = completionScript(shell)
    expect(script).toContain('bccli')
    expect(script).toContain('completion')
    expect(script).toContain('models')
    expect(script).toContain('plugins')
    expect(script).toContain('--model')
  }
})

test('bash and zsh scripts register a completion function', () => {
  expect(completionScript('bash')).toContain('complete -F')
  expect(completionScript('zsh')).toContain('compdef')
})

test('fish script uses complete -c', () => {
  expect(completionScript('fish')).toContain('complete -c bccli')
})

test('powershell script registers a TabExpansion2 argument completer', () => {
  expect(completionScript('powershell')).toContain('Register-ArgumentCompleter')
})

test('runCompletionCommand prints the script for a valid shell', () => {
  const lines: string[] = []
  const code = runCompletionCommand({ subArgs: ['bash'] }, { out: (l) => lines.push(l) })
  expect(code).toBe(0)
  expect(lines.join('\n')).toContain('complete -F')
})

test('runCompletionCommand with no shell arg errors and lists shells', () => {
  const errs: string[] = []
  const code = runCompletionCommand({ subArgs: [] }, { out: () => {}, err: (l) => errs.push(l) })
  expect(code).toBe(1)
  expect(errs.join('\n')).toMatch(/bash, zsh, fish, powershell/)
})

test('runCompletionCommand rejects an unknown shell', () => {
  const errs: string[] = []
  const code = runCompletionCommand({ subArgs: ['tcsh'] }, { out: () => {}, err: (l) => errs.push(l) })
  expect(code).toBe(1)
  expect(errs.join('\n')).toMatch(/bash, zsh, fish, powershell/)
})
