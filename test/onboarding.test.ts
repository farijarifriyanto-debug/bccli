import { describe, expect, it } from 'vitest'
import { firstRunKeyProvider } from '../src/onboarding'
import type { Config } from '../src/config'
import type { CliArgs } from '../src/args'

const config = {
  model: 'bc-cloud/example',
  providers: {
    'bc-cloud': { baseURL: 'https://api.botconnector.id/v1', apiKeyEnv: 'BOTCONNECTOR_API_KEY' },
    ollama: { baseURL: 'http://127.0.0.1:11434/v1' },
  },
} as unknown as Config
const args = { command: 'run', print: false } as CliArgs
const env = { BCCLI_HOME: '/__bccli_no_keys_existing__' }

describe('first-run provider onboarding', () => {
  it('prompts for a missing cloud key only in interactive mode', () => {
    expect(firstRunKeyProvider(args, config, env, true)).toBe('bc-cloud')
    expect(firstRunKeyProvider(args, config, env, false)).toBeUndefined()
    expect(firstRunKeyProvider({ ...args, print: true }, config, env, true)).toBeUndefined()
    expect(firstRunKeyProvider({ ...args, command: 'mcp' }, config, env, true)).toBeUndefined()
  })
  it('never asks for an existing key or local keyless provider', () => {
    expect(firstRunKeyProvider(args, config, { ...env, BOTCONNECTOR_API_KEY: 'fake-test-only' }, true)).toBeUndefined()
    expect(firstRunKeyProvider({ ...args, model: 'ollama/example' }, config, env, true)).toBeUndefined()
  })
})
