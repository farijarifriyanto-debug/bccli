import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, win32 } from 'node:path'
import { expect, test } from 'vitest'
import { createBashTool } from '../../src/tools/bash'
import { resolveShell } from '../../src/tools/shell'

const none = () => false
const programFiles = 'C:\\Program Files'
const gitBash = win32.join(programFiles, 'Git', 'bin', 'bash.exe')
const hasGitBash = (p: string) => p === gitBash
const ctx = () => ({ cwd: mkdtempSync(join(tmpdir(), 'bccli-shell-')), signal: new AbortController().signal, readFiles: new Set<string>() })

const onWindows = process.platform === 'win32'
const realGitBash = onWindows && resolveShell({ platform: 'win32', env: process.env, exists: existsSync })?.name === 'bash'

test('win32 prefers Git Bash so Unix tools (tail, grep, ls) exist', () => {
  const shell = resolveShell({ platform: 'win32', env: { ProgramFiles: programFiles }, exists: hasGitBash })
  expect(shell?.name).toBe('bash')
  expect(shell?.file).toBe(gitBash)
  expect(shell?.args('echo hi')).toEqual(['-c', 'echo hi'])
})

test('win32 finds Git Bash next to git.exe on PATH', () => {
  const gitCmd = 'D:\\tools\\Git\\cmd'
  const bash = win32.join('D:\\tools\\Git', 'bin', 'bash.exe')
  const shell = resolveShell({
    platform: 'win32',
    env: { PATH: gitCmd },
    exists: (p) => p === win32.join(gitCmd, 'git.exe') || p === bash,
  })
  expect(shell?.file).toBe(bash)
})

test('win32 without Git Bash falls back to PowerShell and never uses cmd.exe', () => {
  const shell = resolveShell({ platform: 'win32', env: {}, exists: none })
  expect(shell?.name).toBe('powershell')
  expect(shell?.file).toBe('powershell.exe')
  expect(shell?.file).not.toMatch(/cmd(\.exe)?$/i)
  const args = shell!.args('node -e "console.log(1)"')
  expect(args.at(-2)).toBe('-EncodedCommand')
  const script = Buffer.from(args.at(-1) as string, 'base64').toString('utf16le')
  expect(script).toContain('OutputEncoding')
  expect(script).toContain('node -e "console.log(1)"')
  expect(script).toContain('exit $LASTEXITCODE')
})

test('posix keeps the default sh (no custom shell spec)', () => {
  expect(resolveShell({ platform: 'linux', env: {}, exists: none })).toBeUndefined()
  expect(resolveShell({ platform: 'darwin', env: {}, exists: none })).toBeUndefined()
})

test('tool description names the shell that will run commands on win32', () => {
  const withBash = createBashTool({ platform: 'win32', shellDeps: { env: { ProgramFiles: programFiles }, exists: hasGitBash } })
  expect(withBash.description).toContain('Git Bash')
  const withPs = createBashTool({ platform: 'win32', shellDeps: { env: {}, exists: none } })
  expect(withPs.description).toContain('PowerShell')
  expect(withPs.description).toContain('Select-Object')
})

test.runIf(realGitBash)('Git Bash pipeline with tail works on Windows', async () => {
  const tool = createBashTool({ platform: 'win32' })
  const r = await tool.run({ command: "printf 'a\\nb\\nc\\n' | tail -1" }, ctx())
  expect(r.output).toContain('c')
  expect(r.isError).toBe(false)
})

test.runIf(onWindows)('PowerShell fallback returns exit code and UTF-8 output', async () => {
  const tool = createBashTool({ platform: 'win32', shellDeps: { env: {}, exists: none } })
  const r = await tool.run({ command: "node -e \"console.log('€'); process.exit(3)\"" }, ctx())
  expect(r.output).toContain('€')
  expect(r.output).toContain('[exit code 3]')
  expect(r.isError).toBe(true)
})
