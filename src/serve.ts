import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { basename } from 'node:path'
import type { PermissionAsk, PermissionAnswer } from './agent'
import { parseCliArgs } from './args'
import { bccliHome, loadConfig } from './config'
import { listAllModels } from './models'
import type { Provider } from './provider'
import { Session } from './session'
import { bearerOk, randomToken, trustFence } from './serveProtocol'
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

interface ServedSession {
  id: string
  cwd: string
  rt: Runtime
  permissionMode: PermissionMode
  busy: { turnId: string; controller: AbortController } | null
  /** Open mux streamIds subscribed to this session. */
  streams: Set<string>
  /** Approval requests awaiting a POST /approvals answer; replayed on stream reopen. */
  pending: Map<string, { resolve: (answer: PermissionAnswer) => void; req: PermissionAsk }>
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

/**
 * Starts the loopback session server (HTTP unary + WS mux). Refuses non-loopback
 * bind addresses; every request passes the DSH-style trust fence (403) and, except
 * /health, the bearer-token check (401).
 */
export async function startServe(opts: ServeOptions = {}): Promise<ServeHandle> {
  const env = opts.env ?? process.env
  const cwd = opts.cwd ?? process.cwd()
  const host = opts.host ?? '127.0.0.1'
  if (!LOOPBACK_BIND.has(host)) throw new Error(`serve refuses non-loopback --host ${host} (loopback only)`)
  const token = opts.token ?? env.BCCLI_SERVE_TOKEN ?? randomToken()
  const home = bccliHome(env)
  const sessions = new Map<string, ServedSession>()

  const server: Server = createServer((req, res) => {
    void handleHttp(req, res)
  })

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
      if (body.permissionMode !== undefined && body.permissionMode !== 'ask' && body.permissionMode !== 'bypassPermissions') {
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
        byId.set(basename(session.file, '.jsonl'), { id: basename(session.file, '.jsonl'), mtime: mtime.toISOString(), preview })
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
    jsonError(res, 404, `no route ${method} ${url.pathname}`)
  }

  function findSessionFile(id: string, forCwd: string): { session: Session; cwd: string } | undefined {
    const hit = Session.list(home, forCwd).find(({ session }) => basename(session.file, '.jsonl') === id)
    return hit ? { session: hit.session, cwd: forCwd } : undefined
  }

  function openSession(forCwd: string, permissionMode: PermissionMode, model?: string): ServedSession {
    const rt = createRuntime({
      cwd: forCwd,
      args: { ...parseCliArgs([]), allowAll: permissionMode === 'bypassPermissions', model },
      env,
      provider: opts.provider,
      fetch: opts.fetch,
    })
    return registerSession(rt, forCwd, permissionMode)
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

  await new Promise<void>((resolve) => server.listen(opts.port ?? 8787, host === 'localhost' ? '127.0.0.1' : host, resolve))
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
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}
