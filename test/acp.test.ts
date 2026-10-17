import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { ACP_PROTOCOL_VERSION, type AcpAgent, runAcp } from '../src/acp'
import { parseCliArgs } from '../src/args'

interface Msg {
  id?: number
  method?: string
  result?: { protocolVersion?: number; sessionId?: string; stopReason?: string }
  params?: { update?: { sessionUpdate?: string; content?: { text?: string } } }
  error?: { code?: number }
}

function harness(agent: AcpAgent) {
  const input = new PassThrough()
  const output = new PassThrough()
  let raw = ''
  const messages: Msg[] = []
  output.on('data', (c: Buffer) => {
    raw += c.toString('utf8')
    let idx = raw.indexOf('\n')
    while (idx >= 0) {
      const line = raw.slice(0, idx)
      raw = raw.slice(idx + 1)
      idx = raw.indexOf('\n')
      if (line.trim()) messages.push(JSON.parse(line) as Msg)
    }
  })
  const done = runAcp(input, output, { cwd: '.', newAgent: () => agent })
  const send = (msg: unknown) => input.write(`${JSON.stringify(msg)}\n`)
  const waitFor = async (pred: (m: Msg) => boolean, ms = 3000): Promise<Msg> => {
    const start = Date.now()
    for (;;) {
      const hit = messages.find(pred)
      if (hit) return hit
      if (Date.now() - start > ms) throw new Error(`timeout waiting; got ${JSON.stringify(messages)}`)
      await new Promise((r) => setTimeout(r, 10))
    }
  }
  return { send, waitFor, messages, finish: () => input.end(), done }
}

const echoAgent: AcpAgent = {
  async run(text, onChunk) {
    onChunk(`echo:${text}`)
  },
}

describe('acp', () => {
  it('answers initialize, session/new and session/prompt with chunks', async () => {
    const h = harness(echoAgent)
    h.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    const init = await h.waitFor((m) => m.id === 1)
    expect(init.result?.protocolVersion).toBe(ACP_PROTOCOL_VERSION)
    h.send({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: '.', mcpServers: [] } })
    const sess = await h.waitFor((m) => m.id === 2)
    expect(typeof sess.result?.sessionId).toBe('string')
    h.send({
      jsonrpc: '2.0',
      id: 3,
      method: 'session/prompt',
      params: { sessionId: sess.result?.sessionId, prompt: [{ type: 'text', text: 'hi' }] },
    })
    const chunk = await h.waitFor((m) => m.method === 'session/update')
    expect(chunk.params?.update?.sessionUpdate).toBe('agent_message_chunk')
    expect(chunk.params?.update?.content?.text).toBe('echo:hi')
    const res = await h.waitFor((m) => m.id === 3)
    expect(res.result?.stopReason).toBe('end_turn')
    h.finish()
    await h.done
  })

  it('rejects unknown methods with -32601', async () => {
    const h = harness(echoAgent)
    h.send({ jsonrpc: '2.0', id: 9, method: 'bogus/method', params: {} })
    const err = await h.waitFor((m) => m.id === 9)
    expect(err.error?.code).toBe(-32601)
    h.finish()
    await h.done
  })

  it('session/cancel aborts a running prompt with stopReason cancelled', async () => {
    let cancelled = false
    const slow: AcpAgent = {
      run: (_text, _onChunk, signal) =>
        new Promise<void>((resolve) => {
          const t = setTimeout(resolve, 5000)
          signal.addEventListener('abort', () => {
            cancelled = true
            clearTimeout(t)
            resolve()
          })
        }),
    }
    const h = harness(slow)
    h.send({ jsonrpc: '2.0', id: 1, method: 'session/new', params: { cwd: '.' } })
    const sess = await h.waitFor((m) => m.id === 1)
    h.send({
      jsonrpc: '2.0',
      id: 2,
      method: 'session/prompt',
      params: { sessionId: sess.result?.sessionId, prompt: [{ type: 'text', text: 'slow' }] },
    })
    h.send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: sess.result?.sessionId } })
    const res = await h.waitFor((m) => m.id === 2, 5000)
    expect(res.result?.stopReason).toBe('cancelled')
    expect(cancelled).toBe(true)
    h.finish()
    await h.done
  })

  it('runAcp resolves when the input ends', async () => {
    const h = harness(echoAgent)
    h.finish()
    await expect(h.done).resolves.toBeUndefined()
  })

  it('the cli knows the acp subcommand', () => {
    expect(parseCliArgs(['acp']).command).toBe('acp')
  })
})
