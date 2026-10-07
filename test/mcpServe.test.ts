import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { parseCliArgs } from '../src/args'
import { runMcpServe } from '../src/mcpServer/serve'

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bsrv-'))
  writeFileSync(join(dir, 'credentials'), JSON.stringify({ 'bc-cloud': 'bc_live_stdio' }))
  return dir
}

test('serve connects over the injected transport, lists 4 tools, never echoes the key', async () => {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair()
  const errs: string[] = []
  const done = runMcpServe(parseCliArgs(['mcp', 'serve']), {
    env: { BCCLI_HOME: home() },
    cwd: mkdtempSync(join(tmpdir(), 'bsrv-cwd-')),
    out: () => {},
    err: (s: string) => errs.push(s),
    readSecret: async () => '',
    transport: serverT,
  })
  expect(await done).toBe(0)

  const client = new Client({ name: 'test', version: '1' })
  await client.connect(clientT)
  const { tools } = await client.listTools()
  expect(tools.map((t) => t.name).sort()).toEqual(['bc_chat', 'bc_fetch', 'bc_models', 'bc_search'])
  const log = errs.join('\n')
  expect(log).toContain('mcp serve: 4 tools')
  expect(log).toContain('base=https://api.botconnector.id/v1')
  expect(log).not.toContain('bc_live_stdio')
})

test('serve honors --base-url', async () => {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair()
  const errs: string[] = []
  await runMcpServe(parseCliArgs(['mcp', 'serve', '--base-url', 'https://x.example/v1/']), {
    env: { BCCLI_HOME: home() },
    cwd: mkdtempSync(join(tmpdir(), 'bsrv-cwd-')),
    out: () => {},
    err: (s: string) => errs.push(s),
    readSecret: async () => '',
    transport: serverT,
  })
  expect(errs.join('\n')).toContain('base=https://x.example/v1')
  await clientT.close()
})
