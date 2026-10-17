import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { createBashTool, needsNetwork, offlineEnv, runCommand } from '../../src/tools/bash'

test('needsNetwork flags internet tools but not local git or local scripts', () => {
  expect(needsNetwork('curl https://example.com')).toBe(true)
  expect(needsNetwork('wget -q https://example.com')).toBe(true)
  expect(needsNetwork('git fetch origin')).toBe(true)
  expect(needsNetwork('git push origin main')).toBe(true)
  expect(needsNetwork('git clone https://example.com/repo')).toBe(true)
  expect(needsNetwork('npm install left-pad')).toBe(true)
  expect(needsNetwork('pip install requests')).toBe(true)
  expect(needsNetwork('gh pr list')).toBe(true)
  expect(needsNetwork('docker pull alpine')).toBe(true)
  expect(needsNetwork('Invoke-WebRequest https://example.com')).toBe(true)
  expect(needsNetwork('git status')).toBe(false)
  expect(needsNetwork('git diff HEAD')).toBe(false)
  expect(needsNetwork('node -e "console.log(1)"')).toBe(false)
  expect(needsNetwork('npm test')).toBe(false)
  expect(needsNetwork('npx tsc --noEmit')).toBe(false)
})

test('offline bash blocks network commands with a clear policy error', async () => {
  const tool = createBashTool({ networkPolicy: 'offline' })
  const ctx = { cwd: mkdtempSync(join(tmpdir(), 'bccli-net-')), signal: new AbortController().signal, readFiles: new Set<string>() }
  const blocked = await tool.run({ command: 'curl https://example.com' }, ctx)
  expect(blocked.isError).toBe(true)
  expect(blocked.output).toContain('networkPolicy')
  expect(blocked.output).toContain('curl')
  const bgBlocked = await tool.run({ command: 'git push origin main', background: true }, ctx)
  expect(bgBlocked.isError).toBe(true)
  expect(bgBlocked.output).toContain('networkPolicy')
  const allowed = await tool.run({ command: 'node -e "console.log(99)"' }, ctx)
  expect(allowed.isError).toBeFalsy()
  expect(allowed.output).toContain('99')
  expect(tool.description).toContain('networkPolicy')
})

test('the default policy does not block network commands', async () => {
  const tool = createBashTool()
  const ctx = { cwd: mkdtempSync(join(tmpdir(), 'bccli-net2-')), signal: new AbortController().signal, readFiles: new Set<string>() }
  const r = await tool.run({ command: 'curl --version' }, ctx)
  expect(r.output).not.toContain('networkPolicy')
  expect(r.isError).toBeFalsy()
  expect(tool.description).not.toContain('networkPolicy')
})

test('offlineEnv points every proxy variable at a dead local port', () => {
  const env = offlineEnv({ PATH: '/usr/bin', KEEP: '1' })
  expect(env.KEEP).toBe('1')
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) {
    expect(env[key]).toBe('http://127.0.0.1:9')
  }
  expect(env.NO_PROXY).toBe('')
  expect(env.no_proxy).toBe('')
})

test('runCommand forwards the offline env to the child', async () => {
  const r = await runCommand('node -e "console.log(process.env.HTTP_PROXY || \'unset\')"', {
    cwd: mkdtempSync(join(tmpdir(), 'bccli-net3-')),
    timeoutMs: 30_000,
    signal: new AbortController().signal,
    env: offlineEnv(),
  })
  expect(r.output).toContain('127.0.0.1:9')
  expect(r.exitCode).toBe(0)
})
