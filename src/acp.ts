export const ACP_PROTOCOL_VERSION = 1

/** The minimum an ACP client needs: run one prompt, stream text chunks, allow cancellation. */
export interface AcpAgent {
  run(text: string, onChunk: (text: string) => void, signal: AbortSignal): Promise<void>
}

interface Session {
  controller: AbortController | null
}

/**
 * Agent Client Protocol over newline-delimited JSON-RPC (the transport editors like Zed use).
 * Implements the subset: initialize, session/new, session/prompt (streaming session/update
 * notifications), session/cancel; anything else with an id gets -32601.
 */
export function runAcp(
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
  opts: { cwd: string; newAgent: (cwd: string) => AcpAgent },
): Promise<void> {
  const sessions = new Map<string, Session>()
  let nextSession = 1
  const write = (msg: unknown) => {
    output.write(`${JSON.stringify(msg)}\n`)
  }
  const reply = (id: unknown, result: unknown) => write({ jsonrpc: '2.0', id, result })
  const replyError = (id: unknown, code: number, message: string) => write({ jsonrpc: '2.0', id, error: { code, message } })

  const handle = async (msg: any): Promise<void> => {
    const { id, method, params } = msg ?? {}
    if (method === 'initialize') {
      return reply(id, {
        protocolVersion: ACP_PROTOCOL_VERSION,
        agentCapabilities: {
          loadSession: false,
          promptCapabilities: { image: false, audio: false, embeddedContext: false },
        },
      })
    }
    if (method === 'session/new') {
      const sessionId = `s${nextSession++}`
      sessions.set(sessionId, { controller: null })
      return reply(id, { sessionId })
    }
    if (method === 'session/cancel') {
      sessions.get(params?.sessionId)?.controller?.abort()
      return
    }
    if (method === 'session/prompt') {
      const session = sessions.get(params?.sessionId)
      if (!session) return replyError(id, -32602, 'Unknown session')
      const text = (params?.prompt ?? [])
        .filter((p: any) => p?.type === 'text')
        .map((p: any) => String(p.text ?? ''))
        .join('\n')
      const controller = new AbortController()
      session.controller = controller
      let cancelled = false
      controller.signal.addEventListener('abort', () => {
        cancelled = true
      })
      try {
        const agent = opts.newAgent(params?.cwd ?? opts.cwd)
        await agent.run(
          text,
          (chunk) => {
            write({
              jsonrpc: '2.0',
              method: 'session/update',
              params: {
                sessionId: params.sessionId,
                update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: chunk } },
              },
            })
          },
          controller.signal,
        )
      } catch (e) {
        return replyError(id, -32603, (e as Error).message)
      } finally {
        session.controller = null
      }
      return reply(id, { stopReason: cancelled ? 'cancelled' : 'end_turn' })
    }
    if (id !== undefined) return replyError(id, -32601, 'Method not found')
  }

  return new Promise<void>((resolve) => {
    let buf = ''
    const onData = (chunk: Buffer | string) => {
      buf += chunk.toString()
      let idx: number
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx)
        buf = buf.slice(idx + 1)
        if (!line.trim()) continue
        let msg: unknown
        try {
          msg = JSON.parse(line)
        } catch {
          continue // a corrupt line must not kill the connection
        }
        void handle(msg)
      }
    }
    const onEnd = () => {
      input.removeListener('data', onData)
      resolve()
    }
    input.on('data', onData)
    input.on('end', onEnd)
  })
}

/** Production agent: one bccli runtime per prompt turn, permissions allowAll (the editor mediates). */
export function runtimeAgent(cwd: string): AcpAgent {
  return {
    async run(text, onChunk, signal) {
      const { parseCliArgs } = await import('./args')
      const { createRuntime } = await import('./setup')
      const rt = createRuntime({ cwd, args: { ...parseCliArgs([]), allowAll: true } })
      rt.agent.onEvent = (event) => {
        if (event.type === 'text') onChunk(event.delta)
      }
      await rt.agent.run(text, signal)
    },
  }
}
