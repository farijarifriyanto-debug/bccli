// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the fixture configs are literal ${VAR} placeholders on purpose
import { expect, test } from 'vitest'
import { expandEnvVars } from '../src/mcp/config'

test('${VAR} in a stdio config expands from the parent environment at connect time', () => {
  const config = expandEnvVars(
    { command: '${BIN_PATH}/serve', args: ['--token', '${API_TOKEN}', '--port', '8080'], env: { KEY: '${API_TOKEN}' } },
    { BIN_PATH: '/usr/local/bin', API_TOKEN: 'secret-1' },
  )
  expect(config).toEqual({
    command: '/usr/local/bin/serve',
    args: ['--token', 'secret-1', '--port', '8080'],
    env: { KEY: 'secret-1' },
  })
})

test('${VAR} in an http config expands url and headers', () => {
  const config = expandEnvVars(
    { type: 'http', url: '${API_BASE}/mcp', headers: { Authorization: 'Bearer ${API_TOKEN}' } },
    { API_BASE: 'https://api.example.com', API_TOKEN: 'abc' },
  )
  expect(config).toEqual({
    type: 'http',
    url: 'https://api.example.com/mcp',
    headers: { Authorization: 'Bearer abc' },
  })
})

test('${VAR:-default} falls back when unset; unset without a default stays literal', () => {
  const config = expandEnvVars({ command: 'x', args: ['${MISSING:-fallback}', '${MISSING}'] }, {})
  expect(config).toEqual({ command: 'x', args: ['fallback', '${MISSING}'] })
})

test('text without ${VAR} placeholders is untouched', () => {
  const input = { command: 'npx', args: ['-y', '@scope/pkg@latest', '--flag=$HOME'], env: { A: '1' } }
  expect(expandEnvVars(input, { HOME: '/h' })).toEqual(input)
})
