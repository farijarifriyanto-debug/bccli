import type { PermissionAnswer, PermissionAsk } from './agent'
import type { Runtime } from './setup'

export const ACP_PROTOCOL_VERSION = 1

/** What the agent reports to the editor besides text: tool calls, and permission questions the editor answers. */
export interface AcpIo {
  toolStart(id: string, tool: string, target: string): void
  toolEnd(id: string, output: string, isError: boolean): void
  askPermission(req: PermissionAsk): Promise<PermissionAnswer>
  onThinking?(delta: string): void
}

/** The minimum an ACP client needs: run one prompt, stream text chunks, allow cancellation. */
export interface AcpAgent {
  run(text: string, onChunk: (text: string) => void, signal: AbortSignal, io?: AcpIo): Promise<void>
}

interface OpenCall {
  id: string
  tool: string
  target: string
}

interface Session {
  controller: AbortController | null
  /** One agent per session so the conversation and "allow for this session" answers carry over between prompts. */
  agent?: AcpAgent
  /** Permission questions waiting for the editor; a cancel answers them all with "no". */
  pending: Set<(answer: PermissionAnswer) => void>
  open: OpenCall[]
}

interface AcpPromptBlock {
  type?: string
  text?: string
  resource?: { uri?: string; text?: string }
}

interface AcpParams {
  sessionId?: string
  cwd?: string
  prompt?: AcpPromptBlock[]
}

interface JsonRpcMessage {
  id?: unknown
  method?: string
  params?: AcpParams
  result?: { outcome?: { outcome?: string; optionId?: string } }
  error?: unknown
}

type ToolKind = 'read' | 'edit' | 'search' | 'execute' | 'fetch' | 'other'

// bccli tool name -> ACP tool kind (anything not listed is 'other').
const TOOL_KINDS: Record<string, ToolKind> = {
  read: 'read',
  repo_map: 'read',
  edit: 'edit',
  write: 'edit',
  grep: 'search',
  glob: 'search',
  bash: 'execute',
  powershell: 'execute',
  fetch: 'fetch',
  web_search: 'fetch',
}

const kindOf = (tool: string): ToolKind => TOOL_KINDS[tool] ?? 'other'
const titleOf = (tool: string, target: string): string => (target ? `${tool}: ${target}` : tool).slice(0, 200)
const MAX_OUTPUT = 4000

// Option ids are ours; the editor shows the names and returns the id it was given.
const PERMISSION_OPTIONS = [
  { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
  { optionId: 'allow_session', name: 'Allow for this session', kind: 'allow_always' },
  { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
] as const

const ANSWERS: Record<string, PermissionAnswer> = { allow: 'yes', allow_session: 'session', reject: 'no' }

/**
 * Agent Client Protocol over newline-delimited JSON-RPC (the transport editors like Zed use).
 * Implements the subset: initialize, session/new, session/prompt (streaming session/update
 * notifications: text chunks and tool calls), session/request_permission, session/cancel;
 * anything else with an id gets -32601.
 */
export function runAcp(
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
  opts: { cwd: string; newAgent: (cwd: string) => AcpAgent },
): Promise<void> {
  const sessions = new Map<string, Session>()
  const awaiting = new Map<unknown, (message: JsonRpcMessage) => void>()
  let nextSession = 1
  let nextRequest = 1
  const write = (msg: unknown) => {
    output.write(`${JSON.stringify(msg)}\n`)
  }
  const reply = (id: unknown, result: unknown) => write({ jsonrpc: '2.0', id, result })
  const replyError = (id: unknown, code: number, message: string) => write({ jsonrpc: '2.0', id, error: { code, message } })
  const update = (sessionId: string, body: Record<string, unknown>) => write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: body } })

  const ioFor = (sid: string, session: Session): AcpIo => ({
    onThinking(delta) {
      update(sid, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: delta } })
    },
    toolStart(id, tool, target) {
      session.open.push({ id, tool, target })
      update(sid, { sessionUpdate: 'tool_call', toolCallId: id, title: titleOf(tool, target), kind: kindOf(tool), status: 'in_progress', rawInput: { target } })
    },
    toolEnd(id, output, isError) {
      session.open = session.open.filter((c) => c.id !== id)
      const text = output.length > MAX_OUTPUT ? `${output.slice(0, MAX_OUTPUT)}\n[truncated]` : output
      update(sid, {
        sessionUpdate: 'tool_call_update',
        toolCallId: id,
        status: isError ? 'failed' : 'completed',
        ...(text ? { content: [{ type: 'content', content: { type: 'text', text } }] } : {}),
      })
    },
    askPermission(req) {
      return new Promise<PermissionAnswer>((resolve) => {
        const requestId = nextRequest++
        // toolStart is emitted before the question, so the editor already knows this call.
        const call = [...session.open].reverse().find((c) => c.tool === req.tool && c.target === req.target)
        const settle = (answer: PermissionAnswer) => {
          session.pending.delete(settle)
          awaiting.delete(requestId)
          resolve(answer)
        }
        session.pending.add(settle)
        awaiting.set(requestId, (message) => {
          const outcome = message.result?.outcome
          settle(outcome?.outcome === 'selected' ? (ANSWERS[outcome.optionId ?? ''] ?? 'no') : 'no')
        })
        write({
          jsonrpc: '2.0',
          id: requestId,
          method: 'session/request_permission',
          params: {
            sessionId: sid,
            toolCall: { toolCallId: call?.id ?? `permission-${requestId}`, title: titleOf(req.tool, req.target), kind: kindOf(req.tool), status: 'pending' },
            options: PERMISSION_OPTIONS,
          },
        })
      })
    },
  })

  const handle = async (msg: JsonRpcMessage): Promise<void> => {
    const { id, method, params } = msg ?? {}
    // The editor's answer to a request we sent (a permission question).
    if (method === undefined && id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      awaiting.get(id)?.(msg)
      return
    }
    if (method === 'initialize') {
      return reply(id, {
        protocolVersion: ACP_PROTOCOL_VERSION,
        agentCapabilities: {
          loadSession: false,
          promptCapabilities: { image: false, audio: false, embeddedContext: true },
        },
      })
    }
    if (method === 'session/new') {
      const sessionId = `s${nextSession++}`
      sessions.set(sessionId, { controller: null, pending: new Set(), open: [] })
      return reply(id, { sessionId })
    }
    if (method === 'session/cancel') {
      const session = sessions.get(params?.sessionId ?? '')
      session?.controller?.abort()
      for (const settle of [...(session?.pending ?? [])]) settle('no')
      return
    }
    if (method === 'session/prompt') {
      const sid = params?.sessionId ?? ''
      const session = sessions.get(sid)
      if (!session) return replyError(id, -32602, 'Unknown session')
      if (session.controller) return replyError(id, -32000, 'Session is busy')
      const text = (params?.prompt ?? [])
        .map((p) => {
          if (p?.type === 'text') return String(p.text ?? '')
          if ((p?.type === 'resource' || p?.type === 'embeddedContext') && p.resource?.text) {
            const label = p.resource.uri ? `\n[${p.resource.uri}]\n` : '\n'
            return `${label}${p.resource.text}`
          }
          return ''
        })
        .filter(Boolean)
        .join('\n')
      const controller = new AbortController()
      session.controller = controller
      let cancelled = false
      controller.signal.addEventListener('abort', () => {
        cancelled = true
      })
      try {
        session.agent ??= opts.newAgent(params?.cwd ?? opts.cwd)
        await session.agent.run(text, (chunk) => update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: chunk } }), controller.signal, ioFor(sid, session))
      } catch (e) {
        if (cancelled) return reply(id, { stopReason: 'cancelled' })
        return replyError(id, -32603, (e as Error).message)
      } finally {
        if (session.controller === controller) {
          session.controller = null
          session.open = []
        }
      }
      return reply(id, { stopReason: cancelled ? 'cancelled' : 'end_turn' })
    }
    if (id !== undefined) return replyError(id, -32601, 'Method not found')
  }

  return new Promise<void>((resolve) => {
    let buf = ''
    const onData = (chunk: Buffer | string) => {
      buf += chunk.toString()
      let idx = buf.indexOf('\n')
      while (idx >= 0) {
        const line = buf.slice(0, idx)
        buf = buf.slice(idx + 1)
        idx = buf.indexOf('\n')
        if (!line.trim()) continue
        let msg: JsonRpcMessage
        try {
          msg = JSON.parse(line) as JsonRpcMessage
        } catch {
          continue // a corrupt line must not kill the connection
        }
        void handle(msg)
      }
    }
    const onEnd = () => {
      input.removeListener('data', onData)
      for (const session of sessions.values()) {
        session.controller?.abort()
        for (const settle of [...session.pending]) settle('no')
      }
      resolve()
    }
    input.on('data', onData)
    input.on('end', onEnd)
  })
}

/**
 * Production agent: one bccli runtime per ACP session. Permission questions go to the editor
 * (session/request_permission); `allowAll` skips them and runs everything unasked.
 */
export function runtimeAgent(cwd: string, allowAll = false): AcpAgent {
  let rt: Runtime | undefined
  return {
    async run(text, onChunk, signal, io) {
      if (!rt) {
        const { parseCliArgs } = await import('./args')
        const { createRuntime } = await import('./setup')
        rt = createRuntime({ cwd, args: { ...parseCliArgs([]), allowAll } })
      }
      if (io && !allowAll) rt.agent.askPermission = (req) => io.askPermission(req)
      let turnError: string | undefined
      rt.agent.onEvent = (event) => {
        if (event.type === 'text') onChunk(event.delta)
        else if (event.type === 'thinking') io?.onThinking?.(event.delta)
        else if (event.type === 'toolStart') io?.toolStart(event.id, event.tool, event.target)
        else if (event.type === 'toolEnd') io?.toolEnd(event.id, event.output, event.isError)
        else if (event.type === 'error') turnError = event.message
        else if (event.type === 'budgetExceeded') turnError = `Budget exceeded (${event.kind})`
      }
      await rt.agent.run(text, signal)
      if (turnError) throw new Error(turnError)
    },
  }
}
