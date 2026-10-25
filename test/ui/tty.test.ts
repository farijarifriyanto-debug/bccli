import { expect, test } from 'vitest'
import { isRealTty, isTtyStream, streamColumns } from '../../src/ui/tty'

test('isTtyStream accepts only streams that report isTTY true', () => {
  expect(isTtyStream({ isTTY: true })).toBe(true)
  expect(isTtyStream({ isTTY: false })).toBe(false)
  expect(isTtyStream({})).toBe(false)
  expect(isTtyStream(undefined)).toBe(false)
  expect(isTtyStream(null)).toBe(false)
})

test('isRealTty needs a file descriptor, so fake stdout from ink-testing-library stays non-TTY', () => {
  expect(isRealTty({ isTTY: true, fd: 1 })).toBe(true)
  expect(isRealTty({ isTTY: true })).toBe(false)
  expect(isRealTty({ fd: 1 })).toBe(false)
  expect(isRealTty(undefined)).toBe(false)
})

test('streamColumns reads the TTY width at render time and falls back to 80', () => {
  expect(streamColumns({ columns: 120 })).toBe(120)
  expect(streamColumns({ columns: 0 })).toBe(80)
  expect(streamColumns({})).toBe(80)
  expect(streamColumns(undefined)).toBe(80)
})
