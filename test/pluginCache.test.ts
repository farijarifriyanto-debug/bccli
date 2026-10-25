import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { parseCliArgs } from '../src/args'
import type { Completion, Provider } from '../src/provider'
import { createRuntime } from '../src/setup'

const provider: Provider = {
  async chat(): Promise<Completion> {
    return { text: '', toolCalls: [] }
  },
  async listModels() {
    return []
  },
}

function project() {
  const home = mkdtempSync(join(tmpdir(), 'bccli-plg-'))
  const cwd = mkdtempSync(join(tmpdir(), 'bccli-plgcwd-'))
  const marker = join(home, 'activate.log')
  const plugin = join(home, 'marker-plugin.cjs')
  writeFileSync(
    plugin,
    `const fs = require('node:fs')\nmodule.exports = () => { fs.appendFileSync(${JSON.stringify(marker)}, 'run\\n') }\n`,
  )
  writeFileSync(join(home, 'config.json'), JSON.stringify({ plugins: [plugin] }))
  const env = { BCCLI_HOME: home, BOTCONNECTOR_API_KEY: 'k' } as NodeJS.ProcessEnv
  const activations = () => (readFileSync(marker, 'utf8').trim().split('\n').filter(Boolean)).length
  return { cwd, env, marker, activations }
}

test('a plugin is activated once per process for the same project, not once per runtime', async () => {
  // gh-bot builds a runtime for every webhook comment; repeating activate() would repeat the
  // plugin's side effects on every comment.
  const p = project()
  createRuntime({ cwd: p.cwd, args: parseCliArgs([]), env: p.env, provider })
  createRuntime({ cwd: p.cwd, args: parseCliArgs([]), env: p.env, provider })
  expect(p.activations()).toBe(1)
})

test('a different project still gets its own activation', async () => {
  const p = project()
  const other = mkdtempSync(join(tmpdir(), 'bccli-plgcwd2-'))
  createRuntime({ cwd: p.cwd, args: parseCliArgs([]), env: p.env, provider })
  createRuntime({ cwd: other, args: parseCliArgs([]), env: p.env, provider })
  expect(p.activations()).toBe(2)
})
