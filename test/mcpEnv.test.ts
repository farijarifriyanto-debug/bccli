import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { mcpChildEnv } from '../src/mcp/manager'

describe('mcpChildEnv', () => {
  beforeEach(() => {
    process.env.BCCLI_TEST_SECRET = 'super-secret-value'
  })
  afterEach(() => {
    delete process.env.BCCLI_TEST_SECRET
  })

  test('does not forward unrelated process env (secrets) to the MCP child', () => {
    const env = mcpChildEnv()
    expect(env.BCCLI_TEST_SECRET).toBeUndefined()
  })

  test('forwards whitelisted vars that are set on this platform', () => {
    const env = mcpChildEnv()
    const whitelist = [
      'PATH',
      'HOME',
      'USERPROFILE',
      'LANG',
      'LC_ALL',
      'TZ',
      'TMP',
      'TEMP',
      'TMPDIR',
      'SYSTEMROOT',
      'SYSTEMDRIVE',
      'COMSPEC',
      'PATHEXT',
      'APPDATA',
      'LOCALAPPDATA',
      'HOMEDRIVE',
      'HOMEPATH',
      'USERNAME',
      'PROGRAMFILES',
      'PROCESSOR_ARCHITECTURE',
      'LOGNAME',
      'SHELL',
      'TERM',
      'USER',
    ]
    for (const key of whitelist) {
      if (process.env[key] !== undefined) expect(env[key], key).toBe(process.env[key])
    }
    expect(Object.keys(env).length).toBeGreaterThan(0)
  })

  test('merges the server config extras and lets them override the whitelist', () => {
    const env = mcpChildEnv({ FOO: '1', PATH: '/custom/bin' })
    expect(env.FOO).toBe('1')
    expect(env.PATH).toBe('/custom/bin')
    expect(env.BCCLI_TEST_SECRET).toBeUndefined()
  })
})
