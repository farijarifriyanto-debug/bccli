import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { readTool } from '../src/tools/read'

const setup = (content: string) => {
  const cwd = mkdtempSync(join(tmpdir(), 'bccli-read-'))
  writeFileSync(join(cwd, 'a.ts'), content)
  return { cwd, signal: new AbortController().signal, readFiles: new Set<string>() }
}

test('returns numbered lines with the tab the edit tool strips back off', async () => {
  const result = await readTool.run({ path: 'a.ts' }, setup('l1\nl2\n'))
  expect(result.isError).toBeFalsy()
  expect(result.output).toContain('     1\tl1')
  expect(result.output).toContain('     2\tl2')
})

test('an offset past the end says so instead of returning an empty answer', async () => {
  const result = await readTool.run({ path: 'a.ts', offset: 99 }, setup('l1\nl2\n'))
  expect(result.isError).toBe(true)
  expect(result.output).toMatch(/past the end/)
  expect(result.output).toContain('offset 99')
})
