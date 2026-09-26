import { expect, test } from 'vitest'
import { VERSION } from '../src/version'

test('VERSION falls back to a dev version outside the bundle', () => {
  expect(VERSION).toBe('0.0.0-dev')
})
