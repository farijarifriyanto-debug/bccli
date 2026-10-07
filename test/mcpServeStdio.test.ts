import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'

const cliPath = fileURLToPath(new URL('../dist/cli.js', import.meta.url))
const maybe = existsSync(cliPath) ? test : test.skip

function readLine(
  child: ChildProcessWithoutNullStreams,
  buffer: { text: string },
  until: (line: string) => boolean,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout; buffer=${buffer.text.slice(0, 500)}`)), 15_000)
    const pump = (): boolean => {
      for (;;) {
        const idx = buffer.text.indexOf('\n')
        if (idx < 0) return false
        const line = buffer.text.slice(0, idx)
        buffer.text = buffer.text.slice(idx + 1)
        if (until(line)) {
          clearTimeout(timer)
          child.stdout.off('data', onData)
          resolve(line)
          return true
        }
      }
    }
    const onData = (chunk: Buffer): void => {
      buffer.text += chunk.toString('utf8')
      pump()
    }
    child.stdout.on('data', onData)
    pump()
  })
}

maybe('handshakes over real stdio and lists 4 tools', async () => {
  const child = spawn(process.execPath, [cliPath, 'mcp', 'serve'], {
    env: { ...process.env, BOTCONNECTOR_API_KEY: 'bc_live_stdio', BCCLI_HOME: `${process.env.TEMP}/bcstdio-unused` },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const buffer = { text: '' }
  try {
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'stdio-test', version: '1' } },
      })}\n`,
    )
    const init = await readLine(child, buffer, (l) => l.includes('"id":1'))
    expect(init).toContain('serverInfo')
    expect(init).toContain('botconnector')

    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`)
    const list = await readLine(child, buffer, (l) => l.includes('"id":2'))
    for (const name of ['bc_search', 'bc_fetch', 'bc_models', 'bc_chat']) expect(list).toContain(name)
  } finally {
    child.kill()
  }
})
