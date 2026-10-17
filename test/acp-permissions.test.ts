import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { type AcpAgent, type AcpIo, runAcp } from '../src/acp'

interface Msg {
  id?: number
  method?: string
  result?: { sessionId?: string; stopReason?: string }
  params?: {
    sessionId?: string
    update?: { sessionUpdate?: string; toolCallId?: string; title?: string; kind?: string; status?: string }
    toolCall?: { toolCallId?: string; title?: string; kind?: string; status?: string }
    options?: { optionId: string; name: string; kind: string }[]
  }
  error?: { code?: number }
}

function harness(agent: AcpAgent, created?: { n: number }) {
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
  const done = runAcp(input, output, {
    cwd: '.',
    newAgent: () => {
      if (created) created.n++
      return agent
    },
  })
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

type Harness = ReturnType<typeof harness>

async function newSession(h: Harness, id = 1): Promise<string> {
  h.send({ jsonrpc: '2.0', id, method: 'session/new', params: { cwd: '.' } })
  return (await h.waitFor((m) => m.id === id)).result?.sessionId as string
}

const prompt = (h: Harness, id: number, sessionId: string, text = 'go') =>
  h.send({ jsonrpc: '2.0', id, method: 'session/prompt', params: { sessionId, prompt: [{ type: 'text', text }] } })

const echo: AcpAgent = {
  async run(text, onChunk) {
    onChunk(`echo:${text}`)
  },
}

describe('acp tool calls and permissions', () => {
  it('reports a tool call as tool_call then tool_call_update, with the ACP kind', async () => {
    const agent: AcpAgent = {
      async run(_t, _c, _s, io) {
        io?.toolStart('c1', 'read', 'src/a.ts')
        io?.toolEnd('c1', 'file body', false)
        io?.toolStart('c2', 'bash', 'ls')
        io?.toolEnd('c2', 'boom', true)
      },
    }
    const h = harness(agent)
    const sid = await newSession(h)
    prompt(h, 2, sid)
    await h.waitFor((m) => m.id === 2)
    const ups = h.messages.filter((m) => m.method === 'session/update').map((m) => m.params?.update)
    expect(ups[0]).toMatchObject({ sessionUpdate: 'tool_call', toolCallId: 'c1', kind: 'read', status: 'in_progress', title: 'read: src/a.ts' })
    expect(ups[1]).toMatchObject({ sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'completed' })
    expect(ups[2]).toMatchObject({ toolCallId: 'c2', kind: 'execute' })
    expect(ups[3]).toMatchObject({ toolCallId: 'c2', status: 'failed' })
    h.finish()
    await h.done
  })

  it('asks the editor for permission and passes its choice back to the agent', async () => {
    const answers: string[] = []
    const agent: AcpAgent = {
      async run(_t, _c, _s, io) {
        const ask = (io as AcpIo).askPermission
        io?.toolStart('c1', 'edit', 'a.txt')
        answers.push(await ask({ tool: 'edit', kind: 'edit', target: 'a.txt' }))
        io?.toolStart('c2', 'bash', 'rm x')
        answers.push(await ask({ tool: 'bash', kind: 'bash', target: 'rm x' }))
        io?.toolStart('c3', 'bash', 'ls')
        answers.push(await ask({ tool: 'bash', kind: 'bash', target: 'ls' }))
      },
    }
    const h = harness(agent)
    const sid = await newSession(h)
    prompt(h, 2, sid)
    const ask1 = await h.waitFor((m) => m.method === 'session/request_permission')
    expect(ask1.params?.sessionId).toBe(sid)
    expect(ask1.params?.toolCall).toMatchObject({ toolCallId: 'c1', kind: 'edit', status: 'pending' })
    expect(ask1.params?.options?.map((o) => o.kind)).toEqual(['allow_once', 'allow_always', 'reject_once'])
    h.send({ jsonrpc: '2.0', id: ask1.id, result: { outcome: { outcome: 'selected', optionId: 'allow' } } })
    const ask2 = await h.waitFor((m) => m.method === 'session/request_permission' && m.id !== ask1.id)
    expect(ask2.params?.toolCall?.toolCallId).toBe('c2')
    h.send({ jsonrpc: '2.0', id: ask2.id, result: { outcome: { outcome: 'selected', optionId: 'reject' } } })
    const ask3 = await h.waitFor((m) => m.method === 'session/request_permission' && m.id !== ask1.id && m.id !== ask2.id)
    h.send({ jsonrpc: '2.0', id: ask3.id, result: { outcome: { outcome: 'selected', optionId: 'allow_session' } } })
    await h.waitFor((m) => m.id === 2)
    expect(answers).toEqual(['yes', 'no', 'session'])
    // The editor's answers are responses, never mistaken for unknown requests.
    expect(h.messages.some((m) => m.error?.code === -32601)).toBe(false)
    h.finish()
    await h.done
  })

  it('treats a cancelled or unknown outcome as a refusal', async () => {
    const answers: string[] = []
    const agent: AcpAgent = {
      async run(_t, _c, _s, io) {
        answers.push(await (io as AcpIo).askPermission({ tool: 'bash', kind: 'bash', target: 'a' }))
        answers.push(await (io as AcpIo).askPermission({ tool: 'bash', kind: 'bash', target: 'b' }))
      },
    }
    const h = harness(agent)
    const sid = await newSession(h)
    prompt(h, 2, sid)
    const a = await h.waitFor((m) => m.method === 'session/request_permission')
    h.send({ jsonrpc: '2.0', id: a.id, result: { outcome: { outcome: 'cancelled' } } })
    const b = await h.waitFor((m) => m.method === 'session/request_permission' && m.id !== a.id)
    h.send({ jsonrpc: '2.0', id: b.id, result: { outcome: { outcome: 'selected', optionId: 'something-else' } } })
    await h.waitFor((m) => m.id === 2)
    expect(answers).toEqual(['no', 'no'])
    h.finish()
    await h.done
  })

  it('session/cancel answers a waiting permission question with no and ends with stopReason cancelled', async () => {
    let answer = ''
    const agent: AcpAgent = {
      async run(_t, _c, signal, io) {
        answer = await (io as AcpIo).askPermission({ tool: 'bash', kind: 'bash', target: 'x' })
        if (signal.aborted) throw new Error('aborted')
      },
    }
    const h = harness(agent)
    const sid = await newSession(h)
    prompt(h, 2, sid)
    await h.waitFor((m) => m.method === 'session/request_permission')
    h.send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: sid } })
    const res = await h.waitFor((m) => m.id === 2)
    expect(res.result?.stopReason).toBe('cancelled')
    expect(answer).toBe('no')
    h.finish()
    await h.done
  })

  it('keeps one agent per session across prompts, and a new session gets its own', async () => {
    const created = { n: 0 }
    const h = harness(echo, created)
    const s1 = await newSession(h, 1)
    prompt(h, 2, s1, 'one')
    await h.waitFor((m) => m.id === 2)
    prompt(h, 3, s1, 'two')
    await h.waitFor((m) => m.id === 3)
    expect(created.n).toBe(1)
    const s2 = await newSession(h, 4)
    prompt(h, 5, s2, 'three')
    await h.waitFor((m) => m.id === 5)
    expect(created.n).toBe(2)
    h.finish()
    await h.done
  })
})
