import { mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, expect, test } from 'vitest'
import { editTool } from '../../src/tools/edit'
import { readTool } from '../../src/tools/read'
import type { ToolContext } from '../../src/tools/types'
import { writeTool } from '../../src/tools/write'
import { expandAtFileMentions } from '../../src/ui/complete'

let ctx: ToolContext
beforeEach(() => {
  ctx = { cwd: mkdtempSync(join(tmpdir(), 'bccli-tools-')), signal: new AbortController().signal, readFiles: new Set() }
})
const file = (name: string) => join(ctx.cwd, name)

test('read numbers lines, honours offset/limit and reports the remainder', async () => {
  writeFileSync(file('a.txt'), 'one\ntwo\nthree\nfour')
  const r = await readTool.run({ path: 'a.txt', offset: 2, limit: 2 }, ctx)
  expect(r.output).toBe('     2\ttwo\n     3\tthree\n… 1 more lines (use offset)')
  expect(ctx.readFiles.has(file('a.txt'))).toBe(true)
})

test('read caps large multi-line output and provides the next offset', async () => {
  const lines = Array.from({ length: 1000 }, (_, i) => `${String(i).padStart(4, '0')} ${'x'.repeat(120)}`)
  writeFileSync(file('large.txt'), lines.join('\n'))
  const r = await readTool.run({ path: 'large.txt' }, ctx)
  expect(r.output.length).toBeLessThan(41_000)
  expect(r.output).toMatch(/token budget reached; continue with offset=\d+/)
})

test('read truncates a huge single line', async () => {
  writeFileSync(file('min.js'), 'x'.repeat(1_000_000))
  const r = await readTool.run({ path: 'min.js' }, ctx)
  expect(r.output.length).toBeLessThan(2100)
  expect(r.output).toContain('[line truncated]')
})

test('read refuses binary files and reports missing files as errors', async () => {
  writeFileSync(file('b.bin'), Buffer.from([1, 0, 2]))
  expect((await readTool.run({ path: 'b.bin' }, ctx)).isError).toBe(true)
  const missing = await readTool.run({ path: 'nope.txt' }, ctx)
  expect(missing.isError).toBe(true)
  expect(missing.output).toMatch(/nope\.txt/)
})

test('write creates directories; overwriting requires a prior read', async () => {
  expect((await writeTool.run({ path: 'd/new.txt', content: 'hi' }, ctx)).isError).toBeFalsy()
  expect(readFileSync(file('d/new.txt'), 'utf8')).toBe('hi')
  writeFileSync(file('old.txt'), 'old')
  const blocked = await writeTool.run({ path: 'old.txt', content: 'new' }, ctx)
  expect(blocked.isError).toBe(true)
  await readTool.run({ path: 'old.txt' }, ctx)
  expect((await writeTool.run({ path: 'old.txt', content: 'new' }, ctx)).isError).toBeFalsy()
})

test('edit requires read, unique match, and supports replace_all', async () => {
  writeFileSync(file('e.ts'), 'a = 1\nb = 1\n')
  expect((await editTool.run({ path: 'e.ts', old_string: 'a = 1', new_string: 'a = 2' }, ctx)).isError).toBe(true)
  await readTool.run({ path: 'e.ts' }, ctx)
  const ambiguous = await editTool.run({ path: 'e.ts', old_string: '= 1', new_string: '= 3' }, ctx)
  expect(ambiguous.isError).toBe(true)
  expect(ambiguous.output).toMatch(/2 times/)
  expect((await editTool.run({ path: 'e.ts', old_string: 'zzz', new_string: 'q' }, ctx)).output).toMatch(/not found/)
  const ok = await editTool.run({ path: 'e.ts', old_string: 'a = 1', new_string: 'a = 2' }, ctx)
  expect(ok.isError).toBeFalsy()
  expect(ok.display).toContain('+ a = 2')
  await editTool.run({ path: 'e.ts', old_string: '= ', new_string: '== ', replace_all: true }, ctx)
  expect(readFileSync(file('e.ts'), 'utf8')).toBe('a == 2\nb == 1\n')
})

test('edit on a CRLF file matches LF old_string and keeps CRLF', async () => {
  writeFileSync(file('w.txt'), 'line1\r\nline2\r\nline3\r\n')
  await readTool.run({ path: 'w.txt' }, ctx)
  const r = await editTool.run({ path: 'w.txt', old_string: 'line1\nline2', new_string: 'first\nsecond' }, ctx)
  expect(r.isError).toBeFalsy()
  expect(readFileSync(file('w.txt'), 'utf8')).toBe('first\r\nsecond\r\nline3\r\n')
})

test('edit preview is a diff and does not touch the file', async () => {
  writeFileSync(file('p.txt'), 'keep\nold\n')
  await readTool.run({ path: 'p.txt' }, ctx)
  const preview = await editTool.preview!({ path: 'p.txt', old_string: 'old', new_string: 'new' }, ctx)
  expect(preview).toContain('- old')
  expect(preview).toContain('+ new')
  expect(readFileSync(file('p.txt'), 'utf8')).toBe('keep\nold\n')
})

test('edit works in the LF part of a file with mixed line endings', async () => {
  writeFileSync(file('m.txt'), 'a\r\nb\nc\n')
  await readTool.run({ path: 'm.txt' }, ctx)
  const r = await editTool.run({ path: 'm.txt', old_string: 'b\nc', new_string: 'B\nC' }, ctx)
  expect(r.isError).toBeFalsy()
  expect(readFileSync(file('m.txt'), 'utf8')).toBe('a\r\nB\nC\n')
})

test('edit supports fuzzy matching (trailing spaces, curly quotes, line-number prefixes) and multi-edit array', async () => {
  writeFileSync(file('fuzzy.ts'), 'const msg = "hello"   \nconst count = 1\n')
  await readTool.run({ path: 'fuzzy.ts' }, ctx)
  // Trailing spaces + typographic quotes + accidental read line-number prefix
  const r1 = await editTool.run(
    {
      path: 'fuzzy.ts',
      old_string: '     1\tconst msg = “hello”\n     2\tconst count = 1',
      new_string: 'const msg = "world"\nconst count = 2',
    },
    ctx,
  )
  expect(r1.isError).toBeFalsy()
  expect(readFileSync(file('fuzzy.ts'), 'utf8')).toBe('const msg = "world"\nconst count = 2\n')

  // Multi-edit in a single call
  const r2 = await editTool.run(
    {
      path: 'fuzzy.ts',
      edits: [
        { old_string: 'const msg = "world"', new_string: 'const msg = "done"' },
        { old_string: 'const count = 2', new_string: 'const count = 99' },
      ],
    },
    ctx,
  )
  expect(r2.isError).toBeFalsy()
  expect(readFileSync(file('fuzzy.ts'), 'utf8')).toBe('const msg = "done"\nconst count = 99\n')
})

test('read lists directory entries when given a directory path', async () => {
  writeFileSync(file('alpha.txt'), '1')
  writeFileSync(file('beta.txt'), '2')
  const r = await readTool.run({ path: '.' }, ctx)
  expect(r.isError).toBeFalsy()
  expect(r.output).toContain('alpha.txt')
  expect(r.output).toContain('beta.txt')
})

test('edit rejects modifying a file that changed on disk after it was read, and expandAtFileMentions pre-attaches @file context', async () => {
  const target = file('stale.ts')
  writeFileSync(target, 'const v = 1\n')
  await readTool.run({ path: 'stale.ts' }, ctx)
  writeFileSync(target, 'const v = 1 // modified externally\n')
  const future = new Date(Date.now() + 5000)
  utimesSync(target, future, future)

  const staleRes = await editTool.run({ path: 'stale.ts', old_string: 'const v = 1', new_string: 'const v = 2' }, ctx)
  expect(staleRes.isError).toBe(true)
  expect(staleRes.output).toMatch(/modified|changed/i)

  writeFileSync(file('note.ts'), 'export const NOTE = 42\n')
  const expanded = expandAtFileMentions('check @note.ts please', ctx.cwd, ctx.readFiles)
  expect(expanded).toContain('export const NOTE = 42')
  expect(ctx.readFiles.has(file('note.ts'))).toBe(true)
})
