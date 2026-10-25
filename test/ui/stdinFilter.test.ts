import { PassThrough } from 'node:stream'
import { expect, test } from 'vitest'
import { installLegacyMouseFilter, stripLegacyMouseReports } from '../../src/ui/stdinFilter'

test('an X10 legacy mouse report is removed from the input stream', () => {
  expect(stripLegacyMouseReports('\x1b[M #!').text).toBe('')
  expect(stripLegacyMouseReports('ab\x1b[M #!cd').text).toBe('abcd')
  expect(stripLegacyMouseReports('\x1b[M #!\x1b[M #!').text).toBe('')
})

test('a report split across chunks is held back until its three payload bytes arrive', () => {
  const head = stripLegacyMouseReports('ab\x1b[M #')
  expect(head.text).toBe('ab')
  const tail = stripLegacyMouseReports('!cd', head.carry)
  expect(tail.text).toBe('cd')
  expect(tail.carry).toBe('')
})

test('a dangling ESC or ESC[ is carried so a split report is still recognised', () => {
  expect(stripLegacyMouseReports('ab\x1b')).toEqual({ text: 'ab', carry: '\x1b' })
  expect(stripLegacyMouseReports('ab\x1b[')).toEqual({ text: 'ab', carry: '\x1b[' })
  const esc = stripLegacyMouseReports('\x1b')
  expect(esc).toEqual({ text: '', carry: '\x1b' })
  expect(stripLegacyMouseReports('[M #!', esc.carry)).toEqual({ text: '', carry: '' })
})

test('SGR mouse reports and arrow keys pass through untouched', () => {
  expect(stripLegacyMouseReports('ab\x1b[<0;12;17M')).toEqual({ text: 'ab\x1b[<0;12;17M', carry: '' })
  expect(stripLegacyMouseReports('\x1b[A')).toEqual({ text: '\x1b[A', carry: '' })
  expect(stripLegacyMouseReports('\x1b')).toEqual({ text: '', carry: '\x1b' })
})

test('the read filter strips reports while leaving the stream object intact', async () => {
  const source = new PassThrough()
  source.setEncoding('utf8')
  const dispose = installLegacyMouseFilter(source as unknown as NodeJS.ReadStream)
  source.write('\x1b[M #!halo')
  await new Promise((resolve) => setTimeout(resolve, 25))
  expect(source.read()).toBe('halo')
  // A stream whose whole chunk was a report simply has nothing left to read.
  source.write('\x1b[M #!')
  await new Promise((resolve) => setTimeout(resolve, 25))
  expect(source.read()).toBe('')
  dispose()
  source.write('\x1b[M #!sisa')
  await new Promise((resolve) => setTimeout(resolve, 25))
  expect(source.read()).toBe('\x1b[M #!sisa')
})
