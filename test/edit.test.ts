import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { editTool } from '../src/tools/edit'
import { readTool } from '../src/tools/read'

type EditInput = {
  old_string?: string
  new_string?: string
  replace_all?: boolean
  edits?: { old_string: string; new_string: string; replace_all?: boolean }[]
}

/** Runs one edit on a fresh file that has been read first, like the agent would. */
async function editFile(content: string, input: EditInput) {
  const cwd = mkdtempSync(join(tmpdir(), 'bccli-edit-'))
  const path = join(cwd, 'a.txt')
  writeFileSync(path, content)
  const ctx = { cwd, signal: new AbortController().signal, readFiles: new Set<string>() }
  await readTool.run({ path: 'a.txt' }, ctx)
  const result = await editTool.run({ path: 'a.txt', ...input }, ctx)
  return { result, text: readFileSync(path, 'utf8') }
}

test('replaces a unique match exactly', async () => {
  const { result, text } = await editFile('const a = 1\nconst b = 2\n', { old_string: 'const b = 2', new_string: 'const b = 3' })
  expect(result.isError).toBeFalsy()
  expect(text).toBe('const a = 1\nconst b = 3\n')
})

test('refuses an ambiguous match and says how many times it appears', async () => {
  const { result, text } = await editFile('x = 1\nx = 1\n', { old_string: 'x = 1', new_string: 'x = 2' })
  expect(result.isError).toBe(true)
  expect(result.output).toMatch(/appears 2 times/)
  expect(text).toBe('x = 1\nx = 1\n')
})

test('replace_all rewrites every occurrence', async () => {
  const { result, text } = await editFile('x = 1\nx = 1\n', { old_string: 'x = 1', new_string: 'x = 2', replace_all: true })
  expect(result.isError).toBeFalsy()
  expect(text).toBe('x = 2\nx = 2\n')
})

test('matches typographic quotes and dashes written as ASCII', async () => {
  const { result, text } = await editFile('say \u201cdon\u2019t\u201d \u2014 stop\n', { old_string: 'say "don\'t" - stop', new_string: 'say go' })
  expect(result.isError).toBeFalsy()
  expect(text).toBe('say go\n')
})

test('keeps CRLF line endings when the model sends LF', async () => {
  const { result, text } = await editFile('a\r\nb\r\nc\r\n', { old_string: 'a\nb', new_string: 'X\nY' })
  expect(result.isError).toBeFalsy()
  expect(text).toBe('X\r\nY\r\nc\r\n')
})

test('ignores the numbered line prefixes that the read tool adds', async () => {
  const { result, text } = await editFile('a\nb\n', { old_string: '     1\ta\n     2\tb', new_string: 'z' })
  expect(result.isError).toBeFalsy()
  expect(text).toBe('z\n')
})

test('tolerates trailing whitespace on the matched lines', async () => {
  const { result, text } = await editFile('a   \nb\t\nc\n', { old_string: 'a\nb', new_string: 'q' })
  expect(result.isError).toBeFalsy()
  expect(text).toBe('q\nc\n')
})

test('reports a missing match instead of writing anything', async () => {
  const { result, text } = await editFile('a\n', { old_string: 'nope', new_string: 'x' })
  expect(result.isError).toBe(true)
  expect(result.output).toMatch(/not found/)
  expect(text).toBe('a\n')
})

test('rejects an edit whose old and new text are identical', async () => {
  const { result, text } = await editFile('a\n', { old_string: 'a', new_string: 'a' })
  expect(result.isError).toBe(true)
  expect(text).toBe('a\n')
})

test('applies an edits array in order and writes nothing when one of them fails', async () => {
  const ok = await editFile('a\nb\n', {
    edits: [
      { old_string: 'a', new_string: 'A' },
      { old_string: 'b', new_string: 'B' },
    ],
  })
  expect(ok.result.isError).toBeFalsy()
  expect(ok.text).toBe('A\nB\n')

  const failed = await editFile('a\nb\n', {
    edits: [
      { old_string: 'a', new_string: 'A' },
      { old_string: 'missing', new_string: 'X' },
    ],
  })
  expect(failed.result.isError).toBe(true)
  expect(failed.text).toBe('a\nb\n')
})
