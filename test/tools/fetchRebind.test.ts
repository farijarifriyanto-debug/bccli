import { beforeEach, expect, test } from 'vitest'
import { clearFetchCache, createFetchTool } from '../../src/tools/fetch'

const ctx = { cwd: '.', signal: new AbortController().signal, readFiles: new Set<string>() }

beforeEach(() => clearFetchCache())

test('a public hostname that resolves to a private address is blocked (DNS rebinding)', async () => {
  const tool = createFetchTool({
    keenableURL: null,
    lookup: async () => [{ address: '10.1.2.3', family: 4 }],
  })
  const r = await tool.run({ url: 'http://rebind.attacker.example/secret' }, ctx)
  expect(r.isError).toBe(true)
  expect(r.output).toMatch(/private|privat/i) // suite runs in Indonesian by default
  expect(r.output).toContain('10.1.2.3')
})

test('a hostname that fails DNS still reports the fetch error, not the rebinding guard', async () => {
  const tool = createFetchTool({
    keenableURL: null,
    lookup: async () => {
      throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' })
    },
  })
  const r = await tool.run({ url: 'http://nama-host-tidak-ada.invalid/' }, ctx)
  expect(r.isError).toBe(true)
  expect(r.output).toContain('ENOTFOUND')
})

test('an explicit private IP literal stays reachable (the user sees exactly what they typed)', async () => {
  const tool = createFetchTool({
    keenableURL: null,
    lookup: async () => {
      throw new Error('lookup must not be called for an IP literal')
    },
  })
  const r = await tool.run({ url: 'http://127.0.0.1:9/' }, ctx)
  expect(r.output).not.toMatch(/resolves to a private/i)
  expect(r.output).toContain('127.0.0.1')
})
