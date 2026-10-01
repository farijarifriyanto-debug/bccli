import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, expect, test } from 'vitest'
import { globTool } from '../../src/tools/glob'
import { grepJs, grepTool } from '../../src/tools/grep'
import { ALL_TOOLS, toolDefinitions } from '../../src/tools/index'

const root = mkdtempSync(join(tmpdir(), 'bccli-search-'))
const ctx = { cwd: root, signal: new AbortController().signal, readFiles: new Set<string>() }

beforeAll(() => {
  mkdirSync(join(root, 'src'))
  mkdirSync(join(root, 'dist'))
  mkdirSync(join(root, 'node_modules', 'x'), { recursive: true })
  writeFileSync(join(root, '.gitignore'), 'dist/\n# comment\n')
  writeFileSync(join(root, 'src', 'a.ts'), 'export const Needle = 1\n')
  writeFileSync(join(root, 'dist', 'a.js'), 'Needle\n')
  writeFileSync(join(root, 'node_modules', 'x', 'i.js'), 'Needle\n')
})

test('grepJs finds matches and respects .gitignore and node_modules', async () => {
  expect(await grepJs('needle', { root, ignoreCase: true })).toEqual(['src/a.ts:1:export const Needle = 1'])
})

test('grep tool reports no matches clearly', async () => {
  const r = await grepTool.run({ pattern: 'definitely-not-here' }, ctx)
  expect(r.output).toBe('No matches.')
})

test('glob lists files, ignoring gitignored and node_modules', async () => {
  const r = await globTool.run({ pattern: '**/*.{ts,js}' }, ctx)
  expect(r.output).toBe('src/a.ts')
})

test('tool definitions are JSON schema without $schema', () => {
  const defs = toolDefinitions(ALL_TOOLS)
  expect(defs.map((d) => d.function.name)).toEqual(['read', 'write', 'edit', 'bash', 'grep', 'glob', 'fetch'])
  const read = defs[0].function.parameters as { type: string; required: string[]; $schema?: string }
  expect(read.type).toBe('object')
  expect(read.required).toEqual(['path'])
  expect(read.$schema).toBeUndefined()
})
