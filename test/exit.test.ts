import { expect, test } from 'vitest'
import { EXIT_GRACE_MS, settleExit } from '../src/exit'

test('settleExit sets exitCode without killing the process synchronously', () => {
  const codes: number[] = []
  let exitCalls = 0
  let timerMs = -1
  let unrefred = false
  settleExit(3, {
    setExitCode: (c) => codes.push(c),
    exit: () => {
      exitCalls++
    },
    setTimer: (_fn, ms) => {
      timerMs = ms
      return { unref: () => { unrefred = true } }
    },
  })
  expect(codes).toEqual([3])
  expect(exitCalls).toBe(0)
  expect(timerMs).toBe(EXIT_GRACE_MS)
  expect(unrefred).toBe(true)
})

test('settleExit force-exits with the same code when the grace timer fires', () => {
  const exits: number[] = []
  let fire: (() => void) | undefined
  settleExit(7, {
    setExitCode: () => {},
    exit: (c) => exits.push(c),
    setTimer: (fn) => {
      fire = fn
      return { unref: () => {} }
    },
  })
  expect(exits).toEqual([])
  fire?.()
  expect(exits).toEqual([7])
})

test('settleExit force-exits 1 on the error path code', () => {
  const exits: number[] = []
  let fire: (() => void) | undefined
  settleExit(1, {
    setExitCode: () => {},
    exit: (c) => exits.push(c),
    setTimer: (fn) => {
      fire = fn
      return { unref: () => {} }
    },
  })
  fire?.()
  expect(exits).toEqual([1])
})
