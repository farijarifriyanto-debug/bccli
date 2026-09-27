import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { CATALOG, fillTemplate } from '../src/mcp/catalog'
import { McpManager } from '../src/mcp/manager'

test.runIf(process.env.BCCLI_E2E_MCP === '1')('installs the filesystem MCP from the catalog and lists its tools', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'e2e-fs-'))
  const entry = CATALOG.find((c) => c.name === 'filesystem')!
  const manager = new McpManager({ connectTimeoutMs: 120_000 })
  await manager.start([{ name: 'filesystem', source: 'global', config: fillTemplate(entry.config, { dir }) }])
  try {
    expect(manager.states()[0]).toMatchObject({ status: 'ready' })
    expect(manager.tools().length).toBeGreaterThan(3)
  } finally {
    await manager.stop()
  }
}, 180_000)
