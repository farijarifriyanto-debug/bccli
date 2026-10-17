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
  expect(await store.undo()).toEqual({ restored: [join(cwd, 'a.txt')], deleted: [], skipped: [], failed: [] })
  expect(readFileSync(join(cwd, 'a.txt'), 'utf8')).toBe('v3')
  expect(await store.undo()).toEqual({ restored: [join(cwd, 'a.txt')], deleted: [join(cwd, 'new.txt')], skipped: [], failed: [] })
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
  expect(await store.undo()).toEqual({ restored: [], deleted: [], skipped: [big], failed: [] })
})

test('undo keeps going when one file cannot be restored and reports it', async () => {
  const cwd = dir()
  const store = new CheckpointStore()
  const { mkdirSync, rmSync } = await import('node:fs')
  mkdirSync(join(cwd, 'sub'))
  writeFileSync(join(cwd, 'sub', 'x.txt'), 'x1')
  writeFileSync(join(cwd, 'b.txt'), 'b1')
  store.beginTurn()
  await store.snapshot(join(cwd, 'sub', 'x.txt'))
  await store.snapshot(join(cwd, 'b.txt'))
  writeFileSync(join(cwd, 'b.txt'), 'b2')
  rmSync(join(cwd, 'sub'), { recursive: true })
  const result = await store.undo()
  expect(result?.failed).toEqual([join(cwd, 'sub', 'x.txt')])
  expect(result?.restored).toEqual([join(cwd, 'b.txt')])
  expect(readFileSync(join(cwd, 'b.txt'), 'utf8')).toBe('b1')
})

test('redo re-applies the file edits of the last undo', async () => {
  const cwd = dir()
  const store = new CheckpointStore()
  writeFileSync(join(cwd, 'a.txt'), 'v1')
  store.beginTurn()
  await store.snapshot(join(cwd, 'a.txt'))
  writeFileSync(join(cwd, 'a.txt'), 'v2')
  await store.snapshot(join(cwd, 'new.txt'))
  writeFileSync(join(cwd, 'new.txt'), 'created')
  expect(await store.undo()).toEqual({ restored: [join(cwd, 'a.txt')], deleted: [join(cwd, 'new.txt')], skipped: [], failed: [] })
  expect(readFileSync(join(cwd, 'a.txt'), 'utf8')).toBe('v1')
  expect(existsSync(join(cwd, 'new.txt'))).toBe(false)
  expect(await store.redo()).toEqual({ restored: [join(cwd, 'a.txt'), join(cwd, 'new.txt')], deleted: [], skipped: [], failed: [] })
  expect(readFileSync(join(cwd, 'a.txt'), 'utf8')).toBe('v2')
  expect(readFileSync(join(cwd, 'new.txt'), 'utf8')).toBe('created')
  expect(await store.redo()).toBeUndefined()
})

test('a new turn or clear invalidates the redo stack', async () => {
  const cwd = dir()
  const store = new CheckpointStore()
  writeFileSync(join(cwd, 'a.txt'), 'v1')
  store.beginTurn()
  await store.snapshot(join(cwd, 'a.txt'))
  writeFileSync(join(cwd, 'a.txt'), 'v2')
  await store.undo()
  store.beginTurn()
  await store.snapshot(join(cwd, 'a.txt'))
  writeFileSync(join(cwd, 'a.txt'), 'v3')
  expect(await store.redo()).toBeUndefined()
  await store.undo()
  // the new turn snapshotted v1 (state after the first undo), so undo returns there — never v2
  expect(readFileSync(join(cwd, 'a.txt'), 'utf8')).toBe('v1')
  store.clear()
  expect(await store.redo()).toBeUndefined()
})

test('redo after undoTo re-applies every rewound turn at once', async () => {
  const cwd = dir()
  const store = new CheckpointStore()
  writeFileSync(join(cwd, 'a.txt'), 'v1')
  store.beginTurn()
  await store.snapshot(join(cwd, 'a.txt'))
  writeFileSync(join(cwd, 'a.txt'), 'v2')
  store.beginTurn()
  await store.snapshot(join(cwd, 'a.txt'))
  writeFileSync(join(cwd, 'a.txt'), 'v3')
  const entries = store.entries()
  expect(await store.undoTo(entries - 2)).toBeDefined()
  expect(readFileSync(join(cwd, 'a.txt'), 'utf8')).toBe('v1')
  expect(await store.redo()).toBeDefined()
  expect(readFileSync(join(cwd, 'a.txt'), 'utf8')).toBe('v3')
})
