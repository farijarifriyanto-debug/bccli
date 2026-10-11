import { expect, test } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runExportCommand, runImportCommand } from '../src/transferCli'

function makeHome(): string {
  return mkdtempSync(join(tmpdir(), 'bccli-transfer-'))
}

function seedSession(home: string, cwd: string, file: string, lines: unknown[]): string {
  const slug = cwd.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(-100) || 'root'
  const dir = join(home, 'sessions', slug)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, file)
  writeFileSync(path, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`)
  return path
}

const msg = (role: string, text: string) => ({ t: 'msg', m: { role, content: text } })

test('export copies the latest session to a file', () => {
  const home = makeHome()
  const cwd = mkdtempSync(join(tmpdir(), 'bccli-cwd-'))
  seedSession(home, cwd, 'a.jsonl', [msg('user', 'first')])
  seedSession(home, cwd, 'b.jsonl', [msg('user', 'second')])
  const out = join(mkdtempSync(join(tmpdir(), 'bccli-out-')), 'copy.jsonl')
  const errs: string[] = []
  const code = runExportCommand({ subArgs: [out], home, cwd }, { out: () => {}, err: (l) => errs.push(l) })
  expect(code).toBe(0)
  const text = readFileSync(out, 'utf8')
  expect(text).toContain('second')
  expect(text).not.toContain('first')
})

test('export with no session errors when none exist', () => {
  const home = makeHome()
  const cwd = mkdtempSync(join(tmpdir(), 'bccli-cwd-empty-'))
  const errs: string[] = []
  const code = runExportCommand({ subArgs: [], home, cwd }, { out: () => {}, err: (l) => errs.push(l) })
  expect(code).toBe(1)
  expect(errs.join('\n')).toMatch(/no session|tidak ada sesi/i)
})

test('import copies a valid JSONL into the current project', () => {
  const home = makeHome()
  const cwd = mkdtempSync(join(tmpdir(), 'bccli-cwd-imp-'))
  const src = join(mkdtempSync(join(tmpdir(), 'bccli-src-')), 'in.jsonl')
  writeFileSync(src, [msg('user', 'hello'), msg('assistant', 'world')].map((l) => JSON.stringify(l)).join('\n') + '\n')
  const errs: string[] = []
  const code = runImportCommand({ subArgs: [src], home, cwd }, { out: () => {}, err: (l) => errs.push(l) })
  expect(code).toBe(0)
  const slug = cwd.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(-100) || 'root'
  const dir = join(home, 'sessions', slug)
  const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'))
  expect(files.length).toBe(1)
  expect(readFileSync(join(dir, files[0]), 'utf8')).toContain('hello')
})

test('import rejects a file with a non-JSON line and writes nothing', () => {
  const home = makeHome()
  const cwd = mkdtempSync(join(tmpdir(), 'bccli-cwd-bad-'))
  const src = join(mkdtempSync(join(tmpdir(), 'bccli-src-bad-')), 'bad.jsonl')
  writeFileSync(src, JSON.stringify(msg('user', 'ok')) + '\nnot-json\n')
  const errs: string[] = []
  const code = runImportCommand({ subArgs: [src], home, cwd }, { out: () => {}, err: (l) => errs.push(l) })
  expect(code).toBe(1)
  expect(errs.join('\n')).toMatch(/invalid|tidak valid/i)
  const slug = cwd.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(-100) || 'root'
  expect(existsSync(join(home, 'sessions', slug))).toBe(false)
})

test('import with missing file errors', () => {
  const home = makeHome()
  const cwd = mkdtempSync(join(tmpdir(), 'bccli-cwd-miss-'))
  const errs: string[] = []
  const code = runImportCommand({ subArgs: ['/no/such/file.jsonl'], home, cwd }, { out: () => {}, err: (l) => errs.push(l) })
  expect(code).toBe(1)
  expect(errs.join('\n')).toMatch(/not found|tidak ditemukan/i)
})
