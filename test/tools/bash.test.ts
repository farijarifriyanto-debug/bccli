import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { bashTool, runCommand } from '../../src/tools/bash'

const cwd = mkdtempSync(join(tmpdir(), 'bccli-bash-'))
const node = (code: string) => `node -e "${code}"`

test('captures stdout, stderr and exit code in the project directory', async () => {
  const r = await bashTool.run(
    { command: node("console.log(process.cwd()); console.error('warn'); process.exit(3)") },
    { cwd, signal: new AbortController().signal, readFiles: new Set() },
  )
  expect(r.output).toContain('warn')
  expect(r.output).toContain('[exit code 3]')
  expect(r.isError).toBe(true)
})

test('times out long commands', async () => {
  const r = await runCommand(node('setTimeout(()=>{}, 60000)'), { cwd, timeoutMs: 500, signal: new AbortController().signal })
  expect(r.timedOut).toBe(true)
})

test('abort kills the running command', async () => {
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 300)
  const r = await runCommand(node('setTimeout(()=>{}, 60000)'), { cwd, timeoutMs: 60000, signal: controller.signal })
  expect(r.aborted).toBe(true)
})

test('huge output keeps head and tail', async () => {
  const r = await runCommand(node("process.stdout.write('A'.repeat(100000)+'END')"), {
    cwd,
    timeoutMs: 20000,
    signal: new AbortController().signal,
  })
  expect(r.output.length).toBeLessThan(31000)
  expect(r.output).toContain('karakter dipotong')
  expect(r.output.endsWith('END')).toBe(true)
})
