import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { CheckpointStore } from '../src/checkpoints'
import { editTool } from '../src/tools/edit'
import { readTool } from '../src/tools/read'
import { writeTool } from '../src/tools/write'

const dir = () => mkdtempSync(join(tmpdir(), 'bccli-ck-'))

test('undo restores edited files and deletes created ones, turn by turn', async () => {
  const cwd = dir()
  const store = new CheckpointStore()
  const ctx = { cwd, signal: new AbortController().signal, readFiles: new Set<string>(), checkpoint: (p: string) => store.snapshot(p) }
  writeFileSync(join(cwd, 'a.txt'), 'v1')
  store.beginTurn()
  await readTool.run({ path: 'a.txt' }, ctx)
  await editTool.run({ path: 'a.txt', old_string: 'v1', new_string: 'v2' }, ctx)
  await editTool.run({ path: 'a.txt', old_string: 'v2', new_string: 'v3' }, ctx)
  await writeTool.run({ path: 'new.txt', content: 'x' }, ctx)
  store.beginTurn()
  await editTool.run({ path: 'a.txt', old_string: 'v3', new_string: 'v4' }, ctx)
  expect(store.turns()).toBe(2)
  expect(await store.undo()).toEqual({ restored: [join(cwd, 'a.txt')], deleted: [], skipped: [] })
  expect(readFileSync(join(cwd, 'a.txt'), 'utf8')).toBe('v3')
  expect(await store.undo()).toEqual({ restored: [join(cwd, 'a.txt')], deleted: [join(cwd, 'new.txt')], skipped: [] })
  expect(readFileSync(join(cwd, 'a.txt'), 'utf8')).toBe('v1')
  expect(existsSync(join(cwd, 'new.txt'))).toBe(false)
  expect(await store.undo()).toBeUndefined()
})

test('turns without file changes are skipped; only 20 turns are kept; big files are skipped', async () => {
  const cwd = dir()
  const store = new CheckpointStore()
  for (let i = 0; i < 25; i++) {
    store.beginTurn()
    writeFileSync(join(cwd, `f${i}.txt`), 'old')
    await store.snapshot(join(cwd, `f${i}.txt`))
  }
  store.beginTurn()
  expect(store.turns()).toBe(20)
  const big = join(cwd, 'big.bin')
  writeFileSync(big, Buffer.alloc(3 * 1024 * 1024))
  store.beginTurn()
  await store.snapshot(big)
  expect(await store.undo()).toEqual({ restored: [], deleted: [], skipped: [big] })
})
