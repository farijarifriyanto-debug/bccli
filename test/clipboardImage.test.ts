import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { clipboardCommand, clipboardTarget, grabClipboardImage } from '../src/clipboardImage'

const now = new Date('2026-10-07T12:00:00Z')

test('clipboardTarget names a png with a timestamp', () => {
  expect(clipboardTarget(join('C:', 'tmp'), now)).toBe(join('C:', 'tmp', 'bccli-clipboard-20261007-120000.png'))
})

test('windows uses powershell Get-Clipboard and saves PNG', () => {
  const c = clipboardCommand('win32', join('C:', 'tmp', 'x.png'))!
  expect(c.cmd).toBe('powershell.exe')
  const all = c.args.join(' ')
  expect(all).toContain('Get-Clipboard -Format Image')
  expect(all).toContain('x.png')
})

test('darwin uses osascript, linux uses xclip, others are unsupported', () => {
  expect(clipboardCommand('darwin', '/tmp/x.png')!.cmd).toBe('osascript')
  expect(clipboardCommand('linux', '/tmp/x.png')!.args.join(' ')).toContain('xclip')
  expect(clipboardCommand('aix' as NodeJS.Platform, '/tmp/x.png')).toBeUndefined()
})

test('grab returns the saved path when the clipboard held an image', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'bccli-clip-'))
  const target = clipboardTarget(tmp, now)
  const path = await grabClipboardImage({
    platform: 'win32',
    tmpdir: tmp,
    now,
    run: async () => {
      writeFileSync(target, 'PNGFAKE')
      return { code: 0, output: 'OK' }
    },
  })
  expect(path).toBe(target)
  expect(existsSync(target)).toBe(true)
})

test('grab returns undefined on an empty clipboard or unsupported platform', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'bccli-clip2-'))
  expect(await grabClipboardImage({ platform: 'win32', tmpdir: tmp, now, run: async () => ({ code: 0, output: 'EMPTY' }) })).toBeUndefined()
  let called = false
  expect(
    await grabClipboardImage({
      platform: 'aix' as NodeJS.Platform,
      tmpdir: tmp,
      now,
      run: async () => {
        called = true
        return { code: 0, output: 'OK' }
      },
    }),
  ).toBeUndefined()
  expect(called).toBe(false)
})

test('grab returns undefined when the command claims OK but wrote nothing', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'bccli-clip3-'))
  expect(await grabClipboardImage({ platform: 'win32', tmpdir: tmp, now, run: async () => ({ code: 0, output: 'OK' }) })).toBeUndefined()
})
