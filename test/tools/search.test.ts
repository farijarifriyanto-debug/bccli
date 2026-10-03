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

test('grep caps large result sets instead of flooding model context', async () => {
  writeFileSync(
    join(root, 'src', 'many.txt'),
    Array.from({ length: 200 }, (_, i) => `needle-${i} ${'x'.repeat(180)}`).join('\n'),
  )
  const r = await grepTool.run({ pattern: 'needle-' }, ctx)
  expect(r.output.length).toBeLessThan(25_000)
  expect(r.output).toMatch(/more matches omitted/)
})

test('grep tool reports no matches clearly', async () => {
  const r = await grepTool.run({ pattern: 'definitely-not-here' }, ctx)
  expect(r.output).toBe('No matches.')
})

test('glob lists files, ignoring gitignored and node_modules', async () => {
  const r = await globTool.run({ pattern: '**/*.{ts,js}' }, ctx)
  expect(r.output).toBe('src/a.ts')
})

test('glob caps very large path listings', async () => {
  const big = join(root, 'src', 'glob-many')
  mkdirSync(big, { recursive: true })
  for (let i = 0; i < 320; i++) {
    writeFileSync(join(big, `file-${String(i).padStart(3, '0')}-${'x'.repeat(70)}.txt`), 'x')
  }
  const r = await globTool.run({ pattern: 'src/glob-many/*.txt' }, ctx)
  expect(r.output.length).toBeLessThan(25_000)
  expect(r.output).toMatch(/more files omitted/)
})

test('tool definitions are JSON schema without $schema', () => {
  const defs = toolDefinitions(ALL_TOOLS)
  expect(defs.map((d) => d.function.name)).toEqual(['read', 'write', 'edit', 'bash', 'grep', 'glob', 'fetch'])
  const read = defs[0].function.parameters as { type: string; required: string[]; $schema?: string }
  expect(read.type).toBe('object')
  expect(read.required).toEqual(['path'])
  expect(read.$schema).toBeUndefined()
})

test('glob rejects pathological brace nesting before fast-glob', async () => {
  const pattern = `${'{'.repeat(17)}a${'}'.repeat(17)}`
  const r = await globTool.run({ pattern }, ctx)
  expect(r.isError).toBe(true)
  expect(r.output).toMatch(/brace nesting is too deep/)
})

test('grep rejects pathological glob nesting before fast-glob fallback', async () => {
  const glob = `${'{'.repeat(17)}*.ts${'}'.repeat(17)}`
  const r = await grepTool.run({ pattern: 'Needle', glob }, ctx)
  expect(r.isError).toBe(true)
  expect(r.output).toMatch(/brace nesting is too deep/)
})

test('glob rejects oversized patterns before fast-glob', async () => {
  const r = await globTool.run({ pattern: 'a'.repeat(4097) }, ctx)
  expect(r.isError).toBe(true)
  expect(r.output).toMatch(/too long/)
})
