import { mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { readTool } from '../src/tools/read'
import { writeTool } from '../src/tools/write'

const dir = () => mkdtempSync(join(tmpdir(), 'bccli-write-'))
const ctx = (cwd: string) => ({ cwd, signal: new AbortController().signal, readFiles: new Set<string>() })

test('write refuses a file that changed after it was read', async () => {
  const cwd = dir()
  const path = join(cwd, 'a.ts')
  writeFileSync(path, 'v1')
  const c = ctx(cwd)
  await readTool.run({ path: 'a.ts' }, c)
  // Someone else (a formatter, a git checkout, another agent) writes the file.
  writeFileSync(path, 'changed by someone else')
  const later = new Date(Date.now() + 5_000)
  utimesSync(path, later, later)

  const result = await writeTool.run({ path: 'a.ts', content: 'mine' }, c)

  expect(result.isError).toBe(true)
  expect(result.output).toMatch(/modified since it was last read/)
  expect(readFileSync(path, 'utf8')).toBe('changed by someone else')
})

test('write still overwrites a file that was read and left alone', async () => {
  const cwd = dir()
  writeFileSync(join(cwd, 'a.ts'), 'v1')
  const c = ctx(cwd)
  await readTool.run({ path: 'a.ts' }, c)

  const result = await writeTool.run({ path: 'a.ts', content: 'v2' }, c)

  expect(result.isError).toBeFalsy()
  expect(readFileSync(join(cwd, 'a.ts'), 'utf8')).toBe('v2')
})

test('write creates a new file without a prior read', async () => {
  const cwd = dir()
  const result = await writeTool.run({ path: 'new.ts', content: 'x' }, ctx(cwd))
  expect(result.isError).toBeFalsy()
  expect(readFileSync(join(cwd, 'new.ts'), 'utf8')).toBe('x')
})

test('write refuses to overwrite an existing file that was never read (unchanged rule)', async () => {
  const cwd = dir()
  writeFileSync(join(cwd, 'a.ts'), 'v1')
  const result = await writeTool.run({ path: 'a.ts', content: 'v2' }, ctx(cwd))
  expect(result.isError).toBe(true)
  expect(result.output).toMatch(/Read it with read/)
})
