import { expect, test } from 'vitest'
import { diffLines, formatDiff } from '../src/diff'

test('diffLines numbers deletions by old line and additions by new line', () => {
  const lines = diffLines('a\nb\nc\n', 'a\nB\nc\n')
  expect(lines).toEqual([
    { kind: 'ctx', line: 1, text: 'a' },
    { kind: 'del', line: 2, text: 'b' },
    { kind: 'add', line: 2, text: 'B' },
    { kind: 'ctx', line: 3, text: 'c' },
  ])
  expect(formatDiff(lines).split('\n')[1]).toBe('    2 - b')
})
