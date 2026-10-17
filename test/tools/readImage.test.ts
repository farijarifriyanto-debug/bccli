import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, expect, test } from 'vitest'
import { createReadTool, readTool } from '../../src/tools/read'
import type { ToolContext } from '../../src/tools/types'

let ctx: ToolContext
beforeEach(() => {
  ctx = { cwd: mkdtempSync(join(tmpdir(), 'bccli-readimg-')), signal: new AbortController().signal, readFiles: new Set() }
})
const file = (name: string) => join(ctx.cwd, name)

const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const JPEG_HEAD = Buffer.from([0xff, 0xd8, 0xff, 0xe0])
const GIF_HEAD = Buffer.from('GIF89a', 'ascii')
const WEBP_HEAD = Buffer.concat([Buffer.from('RIFF', 'ascii'), Buffer.alloc(4), Buffer.from('WEBP', 'ascii')])

test('read attaches a png and registers it as read', async () => {
  const bytes = Buffer.concat([PNG_HEAD, Buffer.alloc(64, 7)])
  writeFileSync(file('logo.png'), bytes)
  const r = await readTool.run({ path: 'logo.png' }, ctx)
  expect(r.isError).toBeFalsy()
  expect(r.output).toContain('[image attached] logo.png')
  expect(r.output).toContain('png')
  expect(r.images).toHaveLength(1)
  expect(r.images?.[0].mediaType).toBe('image/png')
  expect(r.images?.[0].path).toBe('logo.png')
  expect(Buffer.from(r.images?.[0].data ?? '', 'base64').equals(bytes)).toBe(true)
  expect(ctx.readFiles.has(file('logo.png'))).toBe(true)
})

test('jpeg, gif, and webp are attached with the right media type', async () => {
  const cases: [string, Buffer, string][] = [
    ['a.jpg', JPEG_HEAD, 'image/jpeg'],
    ['b.gif', GIF_HEAD, 'image/gif'],
    ['c.webp', WEBP_HEAD, 'image/webp'],
  ]
  for (const [name, head, mediaType] of cases) {
    writeFileSync(file(name), Buffer.concat([head, Buffer.alloc(32, 1)]))
    const r = await readTool.run({ path: name }, ctx)
    expect(r.isError, name).toBeFalsy()
    expect(r.images?.[0].mediaType, name).toBe(mediaType)
  }
})

test('binary files without an image header still fail as before', async () => {
  writeFileSync(file('b.bin'), Buffer.from([1, 0, 2, 0, 3]))
  const r = await readTool.run({ path: 'b.bin' }, ctx)
  expect(r.isError).toBe(true)
  expect(r.output).toContain('binary file')
  expect(r.images).toBeUndefined()
})

test('images over the 4 MB cap are rejected instead of attached', async () => {
  writeFileSync(file('big.png'), Buffer.concat([PNG_HEAD, Buffer.alloc(4 * 1024 * 1024 + 1, 1)]))
  const r = await readTool.run({ path: 'big.png' }, ctx)
  expect(r.isError).toBe(true)
  expect(r.output).toMatch(/4 MB/)
  expect(r.images).toBeUndefined()
})

test('vision: false keeps the old text-only behavior', async () => {
  const tool = createReadTool({ vision: false })
  writeFileSync(file('logo.png'), Buffer.concat([PNG_HEAD, Buffer.alloc(64, 0)]))
  const r = await tool.run({ path: 'logo.png' }, ctx)
  expect(r.images).toBeUndefined()
  expect(r.isError).toBe(true)
  expect(r.output).toContain('binary file')
})
