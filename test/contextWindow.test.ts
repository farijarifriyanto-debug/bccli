import { expect, test } from 'vitest'
import { contextWindowFor, DEFAULT_CONTEXT_WINDOW } from '../src/contextWindow'

test('known models get their real window; unknown models stay conservative', () => {
  expect(contextWindowFor('bc-cloud/gpt-6-luna')).toBe(272_000)
  expect(contextWindowFor('openrouter/anthropic/claude-sonnet-5')).toBe(200_000)
  expect(contextWindowFor('bc-cloud/claude-opus-5-5')).toBe(200_000)
  expect(contextWindowFor('bc-cloud/gemini-3.1-pro-preview')).toBe(1_048_576)
  expect(contextWindowFor('bc-cloud/glm-5.3-flash')).toBe(DEFAULT_CONTEXT_WINDOW)
  expect(contextWindowFor('provider/some-unknown-model')).toBe(DEFAULT_CONTEXT_WINDOW)
})

test('BCCLI_CONTEXT_WINDOW overrides the lookup for every model', () => {
  expect(contextWindowFor('bc-cloud/glm-5.3-flash', { BCCLI_CONTEXT_WINDOW: '32000' })).toBe(32_000)
  expect(contextWindowFor('bc-cloud/gpt-6-luna', { BCCLI_CONTEXT_WINDOW: '32000' })).toBe(32_000)
  // Garbage overrides fall back instead of breaking the agent.
  expect(contextWindowFor('bc-cloud/glm-5.3-flash', { BCCLI_CONTEXT_WINDOW: 'abc' })).toBe(DEFAULT_CONTEXT_WINDOW)
  expect(contextWindowFor('bc-cloud/glm-5.3-flash', { BCCLI_CONTEXT_WINDOW: '-5' })).toBe(DEFAULT_CONTEXT_WINDOW)
})
