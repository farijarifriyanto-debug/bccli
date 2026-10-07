import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import { basename } from 'node:path'
import { WebSocket, WebSocketServer } from 'ws'
import type { AgentEvent, PermissionAnswer, PermissionAsk } from './agent'
import { parseCliArgs } from './args'
import { bccliHome, loadConfig } from './config'
import { listAllModels } from './models'
import type { Provider } from './provider'
import { Session } from './session'
import { MAX_FRAME_BYTES, bearerOk, parseClientFrame, randomToken, type ServerFrame, trustFence } from './serveProtocol'
import { createRuntime, type Runtime } from './setup'
import { VERSION } from './version'

export interface ServeOptions {
  port?: number
  host?: string
  token?: string
  cwd?: string
  env?: NodeJS.ProcessEnv
  provider?: Provider
  fetch?: typeof fetch
  heartbeatMs?: number
  err?: (s: string) => void
}
export interface ServeHandle {
  port: number
  token: string
  url: string
  close(): Promise<void>
}

export type PermissionMode = 'ask' | 'bypassPermissions'

interface MuxStream {
  id: string
  ws: WebSocket
  session: ServedSession
}

interface ServedSession {
  id: string
  cwd: string
  rt: Runtime
  permissionMode: PermissionMode
  busy: { turnId: string; controller: AbortController } | null
  /** Open mux streams subscribed to this session. */
  streams: Set<MuxStream>
  /** Approval requests awaiting a POST /approvals answer; replayed on stream reopen. */
  pending: Map<string, { resolve: (answer: PermissionAnswer) => void; req: PermissionAsk }>
}

interface WireToolCall {
  name: string
  target: string
  output?: string
  isError?: boolean
}

const MAX_BODY_BYTES = 1024 * 1024
const LOOPBACK_BIND = new Set(['127.0.0.1', 'localhost', '::1'])

function json(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

/** Drains oversized bodies instead of destroying the socket so the client still reads the 413. */
function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve, reject) => {
    let body = ''
    let size = 0
    let tooLarge = false
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > MAX_BODY_BYTES) tooLarge = true
      else body += c
    })
    req.on('end', () => resolve(tooLarge ? null : body))
    req.on('error', reject)
  })
}

function sendFrame(ws: WebSocket, frame: ServerFrame): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame))
}

/**
 * Starts the loopback session server (HTTP unary + WS mux at /v1/mux). Refuses
 * non-loopback bind addresses; every request passes the DSH-style trust fence
 * (403) and, except /health, the bearer-token check (401).
 */
export async function startServe(opts: ServeOptions = {}): Promise<ServeHandle> {
  const env = opts.env ?? process.env
  const cwd = opts.cwd ?? process.cwd()
  const host = opts.host ?? '127.0.0.1'
  if (!LOOPBACK_BIND.has(host)) throw new Error(`serve refuses non-loopback --host ${host} (loopback only)`)
  const token = opts.token ?? env.BCCLI_SERVE_TOKEN ?? randomToken()
  const home = bccliHome(env)
  const sessions = new Map<string, ServedSession>()
  const allSockets = new Set<WebSocket>()

  const server: Server = createServer((req, res) => {
    void handleHttp(req, res)
  })
  const wss = new WebSocketServer({ noServer: true })

  server.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) => {
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    const reject = (status: number, reason: string): void => {
      socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`)
      socket.destroy()
    }
    const fence = trustFence(req.headers as { host?: string; origin?: string; 'sec-fetch-site'?: string }, port)
    if (fence) return reject(403, 'Forbidden')
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
    if (url.pathname !== '/v1/mux') return reject(404, 'Not Found')
    if (!bearerOk(req.headers.authorization, token)) return reject(401, 'Unauthorized')
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
  })

  wss.on('connection', (ws: WebSocket) => {
    allSockets.add(ws)
    const connStreams = new Map<string, MuxStream>()
    ws.on('close', () => {
      allSockets.delete(ws)
      for (const stream of connStreams.values()) stream.session.streams.delete(stream)
      connStreams.clear()
    })
    ws.on('message', (data: Buffer | string) => {
      const rawFrame = String(data)
      if (rawFrame.length > MAX_FRAME_BYTES) {
        sendFrame(ws, { type: 'error', streamId: '', message: 'frame exceeds 256 KB' })
        return
      }
      const frame = parseClientFrame(rawFrame)
      if ('error' in frame) {
        sendFrame(ws, { type: 'error', streamId: '', message: frame.error })
        return
      }
      if (frame.type === 'cancel') {
        const stream = connStreams.get(frame.streamId)
        if (!stream) return // frames for unknown/finished streams are dropped
        connStreams.delete(frame.streamId)
        stream.session.streams.delete(stream)
        sendFrame(ws, { type: 'end', streamId: frame.streamId })
        return
      }
      // open
      if (connStreams.has(frame.streamId)) {
        sendFrame(ws, { type: 'error', streamId: frame.streamId, message: 'duplicate open' })
        return
      }
      const match = frame.target.match(/^session:(.+)$/)
      const sessionId = match ? decodeURIComponent(match[1]) : ''
      const session = sessionId ? (sessions.get(sessionId) ?? attachSession(sessionId, cwd)) : undefined
      if (!session) {
        sendFrame(ws, { type: 'error', streamId: frame.streamId, message: `unknown target ${frame.target}` })
        return
      }
      const stream: MuxStream = { id: frame.streamId, ws, session }
      connStreams.set(frame.streamId, stream)
      session.streams.add(stream)
      // Listener registered BEFORE `ready` — the client's baseline read cannot race delivery.
      sendFrame(ws, { type: 'item', streamId: frame.streamId, value: { type: 'ready', sessionId: session.id, host: { home, version: VERSION } } })
      for (const [requestId, p] of session.pending) {
        sendFrame(ws, {
          type: 'item',
          streamId: frame.streamId,
          value: { type: 'approval_request', requestId, tool: p.req.tool, kind: p.req.kind, target: p.req.target, preview: p.req.preview },
        })
      }
    })
  })

  function broadcast(s: ServedSession, value: unknown): void {
    for (const stream of s.streams) sendFrame(stream.ws, { type: 'item', streamId: stream.id, value })
  }

  async function handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    const fence = trustFence(req.headers as { host?: string; origin?: string; 'sec-fetch-site'?: string }, port)
    if (fence) {
      jsonError(res, 403, fence)
      return
    }
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
    if (url.pathname !== '/health' && !bearerOk(req.headers.authorization, token)) {
      jsonError(res, 401, 'missing or invalid bearer token')
      return
    }
    await route(req, res, url)
  }

  function jsonError(res: ServerResponse, status: number, message: string): void {
    json(res, status, { error: { message } })
  }

  async function route(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const method = req.method ?? 'GET'
    if (method === 'GET' && url.pathname === '/health') {
      json(res, 200, { ok: true, version: VERSION })
      return
    }
    if (method === 'GET' && url.pathname === '/v1/models') {
      try {
        // An injected provider (tests, embedding hosts) is what sessions will use;
        // otherwise fall back to the configured registry.
        const groups = opts.provider
          ? [{ providerId: 'injected', providerName: 'injected', models: await opts.provider.listModels() }]
          : await listAllModels(loadConfig(cwd, env), env, { fetch: opts.fetch })
        json(res, 200, groups)
      } catch (error) {
        jsonError(res, 500, (error as Error).message)
      }
      return
    }
    if (url.pathname === '/v1/sessions' && method === 'POST') {
      const raw = await readBody(req)
      if (raw === null) {
        jsonError(res, 413, 'request body exceeds 1 MB')
        return
      }
      let body: { cwd?: string; permissionMode?: PermissionMode; model?: string } = {}
      if (raw) {
        try {
          body = JSON.parse(raw) as typeof body
        } catch {
          jsonError(res, 400, 'invalid JSON body')
          return
        }
      }
      if (
        body.permissionMode !== undefined &&
        body.permissionMode !== 'ask' &&
        body.permissionMode !== 'bypassPermissions'
      ) {
        jsonError(res, 400, "permissionMode must be 'ask' or 'bypassPermissions'")
        return
      }
      try {
        const s = openSession(body.cwd ?? cwd, body.permissionMode ?? 'ask', body.model)
        json(res, 201, { id: s.id, cwd: s.cwd, permissionMode: s.permissionMode })
      } catch (error) {
        jsonError(res, 500, (error as Error).message)
      }
      return
    }
    if (url.pathname === '/v1/sessions' && method === 'GET') {
      const listCwd = url.searchParams.get('cwd') ?? cwd
      const byId = new Map<string, { id: string; mtime: string; preview: string }>()
      for (const { session, mtime, preview } of Session.list(home, listCwd)) {
        const id = basename(session.file, '.jsonl')
        byId.set(id, { id, mtime: mtime.toISOString(), preview })
      }
      for (const s of sessions.values()) {
        if (s.cwd === listCwd && !byId.has(s.id)) {
          byId.set(s.id, { id: s.id, mtime: new Date().toISOString(), preview: '' })
        }
      }
      json(res, 200, [...byId.values()])
      return
    }
    const one = url.pathname.match(/^\/v1\/sessions\/([^/]+)$/)
    if (one && method === 'GET') {
      const id = decodeURIComponent(one[1])
      const live = sessions.get(id)
      if (live) {
        json(res, 200, { id, cwd: live.cwd, permissionMode: live.permissionMode, messages: live.rt.agent.messages })
        return
      }
      const found = findSessionFile(id, url.searchParams.get('cwd') ?? cwd)
      if (!found) {
        jsonError(res, 404, `unknown session ${id}`)
        return
      }
      json(res, 200, { id, cwd: found.cwd, permissionMode: 'ask', messages: found.session.load() })
      return
    }
    const messages = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/messages$/)
    if (messages && method === 'POST') {
      const raw = await readBody(req)
      if (raw === null) {
        jsonError(res, 413, 'request body exceeds 1 MB')
        return
      }
      let body: { prompt?: unknown } = {}
      if (raw) {
        try {
          body = JSON.parse(raw) as typeof body
        } catch {
          jsonError(res, 400, 'invalid JSON body')
          return
        }
      }
      const id = decodeURIComponent(messages[1])
      let s = sessions.get(id)
      if (!s) s = attachSession(id, url.searchParams.get('cwd') ?? cwd)
      if (!s) {
        jsonError(res, 404, `unknown session ${id}`)
        return
      }
      if (typeof body.prompt !== 'string' || body.prompt === '') {
        jsonError(res, 400, 'prompt must be a non-empty string')
        return
      }
      if (s.busy) {
        jsonError(res, 409, `session ${id} is busy with turn ${s.busy.turnId}`)
        return
      }
      const turnId = randomBytes(6).toString('hex')
      const controller = new AbortController()
      s.busy = { turnId, controller }
      void runTurn(s, body.prompt, controller)
      json(res, 202, { turnId })
      return
    }
    jsonError(res, 404, `no route ${method} ${url.pathname}`)
  }

  /** Runs one turn and streams the mapped events to every open stream of the session. */
  async function runTurn(s: ServedSession, prompt: string, controller: AbortController): Promise<void> {
    let text = ''
    let stopReason: 'done' | 'stepLimit' | 'aborted' | 'budgetExceeded' = 'done'
    const toolCalls: WireToolCall[] = []
    const byId = new Map<string, WireToolCall>()
    let usage = { inputTokens: 0, outputTokens: 0 }
    const map = (event: AgentEvent): void => {
      switch (event.type) {
        case 'text':
          text += event.delta
          broadcast(s, { type: 'text', delta: event.delta })
          break
        case 'textReplace':
          text = event.text
          break
        case 'thinking':
          broadcast(s, { type: 'thinking', delta: event.delta })
          break
        case 'toolStart': {
          const call: WireToolCall = { name: event.tool, target: event.target }
          byId.set(event.id, call)
          toolCalls.push(call)
          broadcast(s, { type: 'tool_use', tool: event.tool, target: event.target })
          break
        }
        case 'toolEnd': {
          const call = byId.get(event.id)
          if (call) {
            call.output = event.output
            call.isError = event.isError
          }
          broadcast(s, { type: 'tool_result', tool: event.tool, output: event.output, isError: event.isError })
          break
        }
        case 'usage':
          usage = { inputTokens: event.inputTokens, outputTokens: event.outputTokens }
          broadcast(s, { type: 'usage', ...usage })
          break
        case 'stepLimit':
          stopReason = 'stepLimit'
          break
        case 'budgetExceeded':
          stopReason = 'budgetExceeded'
          break
        case 'aborted':
          stopReason = 'aborted'
          break
        case 'error':
          broadcast(s, { type: 'error', message: event.message })
          break
        default:
          break
      }
    }
    s.rt.agent.onEvent = map
    try {
      await s.rt.agent.run(prompt, controller.signal)
    } catch {
      stopReason = controller.signal.aborted ? 'aborted' : stopReason
    } finally {
      s.rt.agent.onEvent = () => {}
      s.busy = null
      // Fail closed: approvals left pending when the turn ends are answered 'no'.
      for (const [, p] of s.pending) p.resolve('no')
      s.pending.clear()
      broadcast(s, { type: 'result', text, toolCalls, usage, stopReason })
    }
  }

  function findSessionFile(id: string, forCwd: string): { session: Session; cwd: string } | undefined {
    const hit = Session.list(home, forCwd).find(({ session }) => basename(session.file, '.jsonl') === id)
    return hit ? { session: hit.session, cwd: forCwd } : undefined
  }

  function buildRuntime(forCwd: string, permissionMode: PermissionMode, model?: string): Runtime {
    return createRuntime({
      cwd: forCwd,
      args: { ...parseCliArgs([]), allowAll: permissionMode === 'bypassPermissions', model },
      env,
      provider: opts.provider,
      fetch: opts.fetch,
    })
  }

  function openSession(forCwd: string, permissionMode: PermissionMode, model?: string): ServedSession {
    return registerSession(buildRuntime(forCwd, permissionMode, model), forCwd, permissionMode)
  }

  /** Attaches an on-disk session (from an earlier serve process); permissionMode resets to 'ask'. */
  function attachSession(id: string, forCwd: string): ServedSession | undefined {
    const found = findSessionFile(id, forCwd)
    if (!found) return undefined
    const rt = buildRuntime(found.cwd, 'ask')
    rt.resume(found.session)
    return registerSession(rt, found.cwd, 'ask', id)
  }

  function registerSession(rt: Runtime, forCwd: string, permissionMode: PermissionMode, id?: string): ServedSession {
    const sessionId = id ?? basename(rt.session.file, '.jsonl')
    const s: ServedSession = {
      id: sessionId,
      cwd: forCwd,
      rt,
      permissionMode,
      busy: null,
      streams: new Set(),
      pending: new Map(),
    }
    sessions.set(sessionId, s)
    return s
  }

  await new Promise<void>((resolve) =>
    server.listen(opts.port ?? 8787, host === 'localhost' ? '127.0.0.1' : host, resolve),
  )
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return {
    port,
    token,
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sessions.values()) {
          for (const [, p] of s.pending) p.resolve('no')
          s.pending.clear()
        }
        for (const ws of allSockets) ws.terminate()
        allSockets.clear()
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}
