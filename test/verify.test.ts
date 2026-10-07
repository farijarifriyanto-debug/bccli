import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { ConfigError, loadConfig } from '../src/config'
import { MAX_VERIFY_ROUNDS, runVerify, verifyFollowup, type VerifyFailure } from '../src/verify'

const signal = new AbortController().signal

const load = (global: object) => {
  const h = mkdtempSync(join(tmpdir(), 'bccli-v-'))
  writeFileSync(join(h, 'config.json'), JSON.stringify(global))
  return loadConfig(mkdtempSync(join(tmpdir(), 'bccli-vc-')), { BCCLI_HOME: h })
}

test('runVerify returns failures with exit code and output, running every command', async () => {
  const calls: string[] = []
  const fakeRun = (async (cmd: string) => {
    calls.push(cmd)
    return cmd.includes('bad')
      ? { exitCode: 3, output: 'boom', timedOut: false, aborted: false }
      : { exitCode: 0, output: 'ok', timedOut: false, aborted: false }
  }) as never
  const failures = await runVerify(['good-cmd', 'bad-cmd', 'bad2'], { cwd: '.', env: {}, signal, run: fakeRun })
  expect(calls).toEqual(['good-cmd', 'bad-cmd', 'bad2'])
  expect(failures).toEqual([
    { cmd: 'bad-cmd', exitCode: 3, output: 'boom' },
    { cmd: 'bad2', exitCode: 3, output: 'boom' },
  ])
  expect(MAX_VERIFY_ROUNDS).toBe(2)
})

test('verifyFollowup contains every failed command and truncates long output', () => {
  const long = 'x'.repeat(20000)
  const failures: VerifyFailure[] = [
    { cmd: 'npm run lint', exitCode: 1, output: long },
    { cmd: 'npm test', exitCode: 2, output: 'short' },
  ]
  const text = verifyFollowup(failures, 100)
  expect(text).toContain('npm run lint')
  expect(text).toContain('[exit code 1]')
  expect(text).toContain('npm test')
  expect(text).toContain('[truncated]')
  expect(text.length).toBeLessThan(1000)
})

test('verifyCommands defaults to empty and rejects junk', () => {
  expect(load({}).verifyCommands).toEqual([])
  expect(load({ verifyCommands: ['npm run lint'] }).verifyCommands).toEqual(['npm run lint'])
  expect(load({ verifyCommands: ['  npm run lint  '] }).verifyCommands).toEqual(['npm run lint'])
  expect(() => load({ verifyCommands: 'npm run lint' })).toThrow(ConfigError)
  expect(() => load({ verifyCommands: [''] })).toThrow(ConfigError)
  expect(() => load({ verifyCommands: [42] })).toThrow(ConfigError)
})
