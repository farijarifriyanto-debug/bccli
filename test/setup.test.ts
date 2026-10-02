import { expect, test } from 'vitest'
import { lunaPtcAutoEnabled } from '../src/setup'

test('Luna PTC auto mode is enabled by default for normal users', () => {
  expect(lunaPtcAutoEnabled({})).toBe(true)
  expect(lunaPtcAutoEnabled({ BCCLI_LUNA_PTC: '1' })).toBe(true)
  expect(lunaPtcAutoEnabled({ BCCLI_LUNA_PTC: 'auto' })).toBe(true)
})

test('Luna PTC has an internal emergency kill switch', () => {
  for (const value of ['0', 'false', 'FALSE', 'off', 'no']) {
    expect(lunaPtcAutoEnabled({ BCCLI_LUNA_PTC: value })).toBe(false)
  }
})
