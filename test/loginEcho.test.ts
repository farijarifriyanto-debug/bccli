import { expect, test } from 'vitest'
import { echoFor } from '../src/login'

test('typed characters are echoed so a pasted authorization code is visible', () => {
  expect(echoFor('a')).toBe('a')
  expect(echoFor('Z')).toBe('Z')
  expect(echoFor('#')).toBe('#')
})

test('control keys are never echoed into the line', () => {
  expect(echoFor('\u0003')).toBeUndefined() // Ctrl+C
  expect(echoFor('\u007f')).toBeUndefined() // Backspace (drawn as \b \b by the caller)
  expect(echoFor('\u001b')).toBeUndefined() // Esc / start of an arrow-key sequence
})
