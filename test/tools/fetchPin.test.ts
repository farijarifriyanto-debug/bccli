import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, expect, test } from 'vitest'
import { Agent, fetch as undiciFetch } from 'undici'
import { clearFetchCache, createFetchTool, pinLookup } from '../../src/tools/fetch'

const ctx = { cwd: '.', signal: new AbortController().signal, readFiles: new Set<string>() }

function fakeResponse(text: string) {
  const bytes = new TextEncoder().encode(text)
  let sent = false
  return {
    ok: true,
    status: 200,
    headers: { get: (h: string) => (h === 'content-type' ? 'text/plain' : null) },
    body: {
      getReader: () => ({
        read: async () => {
          if (sent) return { done: true as const, value: undefined }
          sent = true
          return { done: false as const, value: bytes }
        },
      }),
    },
  }
}

function recorder() {
  const calls: Array<{ init?: { dispatcher?: unknown } }> = []
  const fetchPage = (async (_url: unknown, init?: { dispatcher?: unknown }) => {
    calls.push({ init })
    return fakeResponse('pinned page')
  }) as unknown as typeof globalThis.fetch
  return { calls, fetchPage }
}

afterEach(() => {
  clearFetchCache()
})

test('a validated public hostname is fetched through a pinned dispatcher', async () => {
  const { calls, fetchPage } = recorder()
  const tool = createFetchTool({
    keenableURL: null,
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    fetchPage,
  })
  const r = await tool.run({ url: 'http://pinned.attacker.example/x' }, ctx)
  expect(r.isError).toBeFalsy()
  expect(r.output).toContain('pinned page')
  expect(calls).toHaveLength(1)
  expect(calls[0].init?.dispatcher).toBeDefined()
})

test('an IP literal is fetched without a pinning dispatcher', async () => {
  const calls: Array<{ init?: { dispatcher?: unknown } }> = []
  const fetchPage = (async (_url: unknown, init?: { dispatcher?: unknown }) => {
    calls.push({ init })
    throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } })
  }) as unknown as typeof globalThis.fetch
  const tool = createFetchTool({
    keenableURL: null,
    lookup: async () => {
      throw new Error('lookup must not run for an IP literal')
    },
    fetchPage,
  })
  const r = await tool.run({ url: 'http://127.0.0.1:9/' }, ctx)
  expect(r.isError).toBe(true)
  expect(r.output).toContain('127.0.0.1')
  expect(calls).toHaveLength(1)
  expect(calls[0].init?.dispatcher).toBeUndefined()
})

test('pinLookup answers with the pre-validated address (single and all forms)', async () => {
  const lookup = pinLookup([{ address: '93.184.216.34', family: 4 }])
  const single = await new Promise((resolve, reject) => {
    lookup('x.example', {}, (err: unknown, address?: unknown, family?: unknown) => (err ? reject(err) : resolve({ address, family })))
  })
  expect(single).toEqual({ address: '93.184.216.34', family: 4 })
  const all = await new Promise((resolve, reject) => {
    lookup('x.example', { all: true }, (err: unknown, addresses?: unknown) => (err ? reject(err) : resolve(addresses)))
  })
  expect(all).toEqual([{ address: '93.184.216.34', family: 4 }])
})

test('an undici Agent with pinLookup reaches a local server for an unresolvable hostname', async () => {
  const server = createServer((_req, res) => res.end('pin-ok'))
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as AddressInfo).port
  const agent = new Agent({ connect: { lookup: pinLookup([{ address: '127.0.0.1', family: 4 }]) } })
  try {
    // Real DNS for this hostname fails; the pinned lookup must be what connects.
    const res = await undiciFetch(`http://does-not-exist.invalid:${port}/`, { dispatcher: agent })
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('pin-ok')
  } finally {
    await agent.close()
    await new Promise((r) => server.close(r))
  }
})
