import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { Permissions } from '../../src/permissions'
import { createSaveMemoryTool } from '../../src/tools/memory'

const home = mkdtempSync(join(tmpdir(), 'bccli-mem-home-'))
const ctxIn = (cwd: string) => ({ cwd, signal: new AbortController().signal, readFiles: new Set<string>() })

test('saves a bullet to the project AGENTS.md, creating the file when missing', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'bccli-mem-proj-'))
  const tool = createSaveMemoryTool({ home, onSaved: () => {} })
  const r = await tool.run({ content: 'always run tests before commit' }, ctxIn(cwd))
  expect(r.isError).toBeFalsy()
  const file = join(cwd, 'AGENTS.md')
  expect(existsSync(file)).toBe(true)
  expect(readFileSync(file, 'utf8')).toContain('- always run tests before commit')
  expect(r.output).toContain('AGENTS.md')
})

test('scope global writes to the global BCCLI.md', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'bccli-mem-proj2-'))
  const tool = createSaveMemoryTool({ home, onSaved: () => {} })
  const r = await tool.run({ content: 'prefer terse answers', scope: 'global' }, ctxIn(cwd))
  expect(r.isError).toBeFalsy()
  expect(readFileSync(join(home, 'BCCLI.md'), 'utf8')).toContain('- prefer terse answers')
  expect(existsSync(join(cwd, 'AGENTS.md'))).toBe(false)
})

test('saving the same content twice does not duplicate it', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'bccli-mem-dupe-'))
  const tool = createSaveMemoryTool({ home, onSaved: () => {} })
  await tool.run({ content: 'dupe line' }, ctxIn(cwd))
  const second = await tool.run({ content: 'dupe line' }, ctxIn(cwd))
  expect(second.isError).toBeFalsy()
  expect(second.output).toMatch(/already/i)
  const text = readFileSync(join(cwd, 'AGENTS.md'), 'utf8')
  expect(text.match(/- dupe line/g)?.length).toBe(1)
})

test('onSaved fires after a real save but not on a duplicate', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'bccli-mem-cb-'))
  let calls = 0
  const tool = createSaveMemoryTool({ home, onSaved: () => calls++ })
  await tool.run({ content: 'callback line' }, ctxIn(cwd))
  await tool.run({ content: 'callback line' }, ctxIn(cwd))
  expect(calls).toBe(1)
})

test('blank content is rejected', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'bccli-mem-blank-'))
  const tool = createSaveMemoryTool({ home, onSaved: () => {} })
  const r = await tool.run({ content: '   ' }, ctxIn(cwd))
  expect(r.isError).toBe(true)
  expect(existsSync(join(cwd, 'AGENTS.md'))).toBe(false)
})

test('overlong content fails the schema', () => {
  const tool = createSaveMemoryTool({ home, onSaved: () => {} })
  expect(tool.schema.safeParse({ content: 'x'.repeat(501) }).success).toBe(false)
})

test('kind is edit so the default permission mode asks', () => {
  expect(createSaveMemoryTool({ home }).kind).toBe('edit')
})

test('a global memory write is asked for, not auto-allowed as a project edit', () => {
  const tool = createSaveMemoryTool({ home: '/home/u/.bccli' })
  const req = (scope: 'project' | 'global') => ({
    tool: 'save_memory',
    kind: 'edit' as const,
    target: tool.target({ content: 'x', scope }),
  })
  const accept = new Permissions('acceptEdits', [], '/work/app')
  expect(accept.rulesFor(req('global'))).toBeUndefined()
  expect(accept.check(req('global'))).toBe('ask')
  // The prompt shows the file that is really written, not the word "global memory".
  expect(req('global').target).toContain('BCCLI.md')
})

test('a project memory write stays an ordinary in-project edit', () => {
  const tool = createSaveMemoryTool({ home: '/home/u/.bccli' })
  const req = { tool: 'save_memory', kind: 'edit' as const, target: tool.target({ content: 'x', scope: 'project' }) }
  const accept = new Permissions('acceptEdits', [], '/work/app')
  expect(accept.rulesFor(req)).toEqual(['edit(project)'])
  expect(accept.check(req)).toBe('allow')
})
