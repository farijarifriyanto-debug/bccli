import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, vi } from 'vitest'
import type { Runtime } from '../src/setup'

vi.mock('ink', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ink')>()
  return { ...actual, render: () => ({ waitUntilExit: async () => {}, unmount: () => {} }) }
})

const { startInteractive } = await import('../src/ui/index')

test('a rejected startMcp does not become an unhandled rejection', async () => {
  const seen: unknown[] = []
  const onRejection = (reason: unknown) => seen.push(reason)
  process.on('unhandledRejection', onRejection)
  try {
    const rt = {
      home: mkdtempSync(join(tmpdir(), 'bccli-si-')),
      cwd: mkdtempSync(join(tmpdir(), 'bccli-sic-')),
      resume: () => {},
      startMcp: () => Promise.reject(new Error('mcp boom')),
      mcp: { stop: async () => {} },
    } as unknown as Runtime
    const code = await startInteractive(rt, { resume: false, version: 'test' })
    expect(code).toBe(0)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(seen).toHaveLength(0)
  } finally {
    process.off('unhandledRejection', onRejection)
  }
})
