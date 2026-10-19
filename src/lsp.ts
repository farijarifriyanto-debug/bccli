import { spawn, type ChildProcess } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { extname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const LANGUAGE_IDS: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescriptreact',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascriptreact',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
  '.rs': 'rust',
  '.go': 'go',
  '.java': 'java',
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.hpp': 'cpp',
  '.cs': 'csharp',
  '.rb': 'ruby',
  '.php': 'php',
  '.json': 'json',
  '.md': 'markdown',
  '.sh': 'shellscript',
  '.ps1': 'powershell',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.toml': 'toml',
  '.html': 'html',
  '.css': 'css',
}

export function languageIdFor(file: string): string {
  return LANGUAGE_IDS[extname(file).toLowerCase()] ?? 'plaintext'
}

export function useShellForLsp(command: string, platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32' && !/\.(exe|mjs|cjs|js)$/i.test(command.trim())
}

export interface LspServer {
  extensions: string[]
  command: string
  args?: string[]
}

export interface LspDiagnostic {
  line: number
  character: number
  severity: number
  message: string
}

export interface LspLocation {
  uri: string
  path: string
  line: number
  character: number
}

export interface WarmLspClient {
  diagnostics(file: string, timeoutMs?: number): Promise<LspDiagnostic[]>
  hover(file: string, line: number, character: number, timeoutMs?: number): Promise<string>
  definition(file: string, line: number, character: number, timeoutMs?: number): Promise<LspLocation[]>
  references(file: string, line: number, character: number, timeoutMs?: number): Promise<LspLocation[]>
  close(): Promise<void>
}

interface LspRawDiagnostic {
  range?: { start?: { line?: number; character?: number } }
  severity?: number
  message?: string
}

/** The JSON-RPC messages this one-shot client cares about. */
export interface LspMessage {
  id?: number
  method?: string
  result?: unknown
  params?: { uri?: string; diagnostics?: LspRawDiagnostic[] }
}

export function encodeLsp(msg: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(msg), 'utf8')
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body])
}

/** Content-Length framed JSON-RPC reader; survives messages split across chunks. */
export function createLspParser(onMessage: (msg: LspMessage) => void): { push(chunk: Buffer): void } {
  let buf = Buffer.alloc(0)
  return {
    push(chunk: Buffer) {
      buf = Buffer.concat([buf, chunk])
      for (;;) {
        const idx = buf.indexOf('\r\n\r\n')
        if (idx < 0) return
        const m = /Content-Length:\s*(\d+)/i.exec(buf.subarray(0, idx).toString('ascii'))
        if (!m) {
          buf = buf.subarray(idx + 4)
          continue
        }
        const len = Number(m[1])
        if (buf.length < idx + 4 + len) return
        const body = buf.subarray(idx + 4, idx + 4 + len)
        buf = buf.subarray(idx + 4 + len)
        try {
          onMessage(JSON.parse(body.toString('utf8')) as LspMessage)
        } catch {
          // a corrupt frame must not kill the stream
        }
      }
    },
  }
}

/**
 * Open one file with one LSP server, wait for its first publishDiagnostics (or the timeout),
 * then shut it down. A one-shot client on purpose: no long-lived servers to manage yet.
 */
export function getDiagnostics(opts: { server: LspServer; cwd: string; file: string; timeoutMs?: number; signal?: AbortSignal }): Promise<LspDiagnostic[]> {
  return new Promise((resolve) => {
    const child = spawn(opts.server.command, opts.server.args ?? [], {
      cwd: opts.cwd,
      stdio: ['pipe', 'pipe', 'ignore'],
      shell: useShellForLsp(opts.server.command),
    })
    const uri = pathToFileURL(opts.file).href
    let settled = false
    let nextId = 2
    const send = (msg: unknown) => {
      try {
        child.stdin.write(encodeLsp(msg))
      } catch {
        // the server may already be gone
      }
    }
    const finish = (diags: LspDiagnostic[]) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      send({ jsonrpc: '2.0', id: nextId++, method: 'shutdown' })
      send({ jsonrpc: '2.0', method: 'exit' })
      const killer = setTimeout(() => {
        try {
          child.kill()
        } catch {
          // already gone
        }
      }, 500)
      killer.unref?.()
      resolve(diags)
    }
    const onAbort = () => finish([])
    if (opts.signal?.aborted) return finish([])
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => finish([]), opts.timeoutMs ?? 8_000)
    const parser = createLspParser((msg) => {
      if (msg.id === 1 && msg.result) {
        send({ jsonrpc: '2.0', method: 'initialized', params: {} })
        let text = ''
        try {
          text = readFileSync(opts.file, 'utf8')
        } catch {
          // didOpen with an empty text still yields server-side parse errors
        }
        send({
          jsonrpc: '2.0',
          method: 'textDocument/didOpen',
          params: { textDocument: { uri, languageId: languageIdFor(opts.file), version: 1, text } },
        })
      }
      if (msg.method === 'textDocument/publishDiagnostics' && msg.params?.uri === uri) {
        finish(
          (msg.params.diagnostics ?? []).map((d) => ({
            line: d.range?.start?.line ?? 0,
            character: d.range?.start?.character ?? 0,
            severity: d.severity ?? 1,
            message: String(d.message ?? ''),
          })),
        )
      }
    })
    child.stdout?.on('data', (c: Buffer) => parser.push(c))
    child.on('error', () => finish([]))
    child.on('close', () => finish([]))
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { processId: process.pid, capabilities: {}, rootUri: pathToFileURL(opts.cwd).href },
    })
  })
}

function extractHoverText(contents: unknown): string {
  if (!contents) return ''
  if (typeof contents === 'string') return contents.trim()
  if (Array.isArray(contents)) return contents.map(extractHoverText).filter(Boolean).join('\n\n')
  if (typeof contents === 'object' && 'value' in contents && typeof (contents as { value?: unknown }).value === 'string') {
    return ((contents as { value: string }).value).trim()
  }
  return ''
}

function normalizeLocations(raw: unknown): LspLocation[] {
  const items = Array.isArray(raw) ? raw : raw ? [raw] : []
  const out: LspLocation[] = []
  for (const item of items) {
    if (!item || typeof item !== 'object') continue
    const rec = item as {
      uri?: string
      targetUri?: string
      range?: { start?: { line?: number; character?: number } }
      targetSelectionRange?: { start?: { line?: number; character?: number } }
      targetRange?: { start?: { line?: number; character?: number } }
    }
    const uri = rec.uri ?? rec.targetUri
    const start = rec.range?.start ?? rec.targetSelectionRange?.start ?? rec.targetRange?.start
    if (!uri) continue
    let path = uri
    try {
      if (uri.startsWith('file:')) path = fileURLToPath(uri)
    } catch {
      // keep raw uri if conversion fails
    }
    out.push({
      uri,
      path,
      line: start?.line ?? 0,
      character: start?.character ?? 0,
    })
  }
  return out
}

/**
 * Persistent warm LSP client: spawns the language server once, sends `didOpen` on first
 * touch of a file and `didChange` on subsequent touches, and serves `diagnostics`,
 * `hover`, `definition`, and `references` over the same warm process.
 */
export function createWarmLspClient(opts: { server: LspServer; cwd: string; timeoutMs?: number }): WarmLspClient {
  let child: ChildProcess | undefined
  let initPromise: Promise<void> | undefined
  let nextId = 2
  const opened = new Map<string, number>()
  const pendingRpc = new Map<number, (result: unknown) => void>()
  const diagWaiters = new Map<string, ((diags: LspDiagnostic[]) => void)[]>()

  const send = (msg: unknown) => {
    try {
      child?.stdin?.write(encodeLsp(msg))
    } catch {
      // child may have exited
    }
  }

  const resetState = () => {
    child = undefined
    initPromise = undefined
    opened.clear()
    for (const [, resolve] of pendingRpc) resolve(undefined)
    pendingRpc.clear()
    for (const [, waiters] of diagWaiters) {
      for (const w of waiters) w([])
    }
    diagWaiters.clear()
  }

  const ensureStarted = (): Promise<void> => {
    if (initPromise && child && !child.killed) return initPromise
    opened.clear()
    initPromise = new Promise<void>((resolveInit) => {
      const proc = spawn(opts.server.command, opts.server.args ?? [], {
        cwd: opts.cwd,
        stdio: ['pipe', 'pipe', 'ignore'],
        shell: useShellForLsp(opts.server.command),
      })
      child = proc
      let initSettled = false
      const settleInit = () => {
        if (!initSettled) {
          initSettled = true
          resolveInit()
        }
      }
      const parser = createLspParser((msg) => {
        if (msg.id === 1 && msg.result !== undefined) {
          send({ jsonrpc: '2.0', method: 'initialized', params: {} })
          settleInit()
          return
        }
        if (msg.id !== undefined && pendingRpc.has(msg.id)) {
          const fn = pendingRpc.get(msg.id)
          pendingRpc.delete(msg.id)
          fn?.(msg.result)
          return
        }
        if (msg.method === 'textDocument/publishDiagnostics' && msg.params?.uri) {
          const uri = msg.params.uri
          const diags = (msg.params.diagnostics ?? []).map((d) => ({
            line: d.range?.start?.line ?? 0,
            character: d.range?.start?.character ?? 0,
            severity: d.severity ?? 1,
            message: String(d.message ?? ''),
          }))
          const list = diagWaiters.get(uri)
          if (list?.length) {
            diagWaiters.delete(uri)
            for (const w of list) w(diags)
          }
        }
      })
      proc.stdout?.on('data', (c: Buffer) => parser.push(c))
      proc.on('error', () => {
        resetState()
        settleInit()
      })
      proc.on('close', () => {
        resetState()
        settleInit()
      })
      send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { processId: process.pid, capabilities: {}, rootUri: pathToFileURL(opts.cwd).href },
      })
    })
    return initPromise
  }

  const syncDocument = (file: string): string => {
    const uri = pathToFileURL(file).href
    let text = ''
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      // empty fallback
    }
    const prevVersion = opened.get(uri)
    if (prevVersion === undefined) {
      opened.set(uri, 1)
      send({
        jsonrpc: '2.0',
        method: 'textDocument/didOpen',
        params: { textDocument: { uri, languageId: languageIdFor(file), version: 1, text } },
      })
    } else {
      const version = prevVersion + 1
      opened.set(uri, version)
      send({
        jsonrpc: '2.0',
        method: 'textDocument/didChange',
        params: {
          textDocument: { uri, version },
          contentChanges: [{ text }],
        },
      })
    }
    return uri
  }

  const request = <T>(method: string, params: unknown, timeoutMs = opts.timeoutMs ?? 8_000): Promise<T | undefined> =>
    new Promise((resolve) => {
      const id = nextId++
      const timer = setTimeout(() => {
        pendingRpc.delete(id)
        resolve(undefined)
      }, timeoutMs)
      pendingRpc.set(id, (res) => {
        clearTimeout(timer)
        resolve(res as T | undefined)
      })
      send({ jsonrpc: '2.0', id, method, params })
    })

  return {
    async diagnostics(file: string, timeoutMs = opts.timeoutMs ?? 8_000): Promise<LspDiagnostic[]> {
      await ensureStarted()
      if (!child) return []
      const uri = pathToFileURL(file).href
      return new Promise<LspDiagnostic[]>((resolve) => {
        const timer = setTimeout(() => {
          const list = diagWaiters.get(uri) ?? []
          diagWaiters.set(
            uri,
            list.filter((w) => w !== onDiag),
          )
          resolve([])
        }, timeoutMs)
        const onDiag = (diags: LspDiagnostic[]) => {
          clearTimeout(timer)
          resolve(diags)
        }
        const list = diagWaiters.get(uri) ?? []
        list.push(onDiag)
        diagWaiters.set(uri, list)
        syncDocument(file)
      })
    },
    async hover(file: string, line: number, character: number, timeoutMs?: number): Promise<string> {
      await ensureStarted()
      if (!child) return ''
      const uri = syncDocument(file)
      const res = await request<{ contents?: unknown }>('textDocument/hover', { textDocument: { uri }, position: { line, character } }, timeoutMs)
      return extractHoverText(res?.contents)
    },
    async definition(file: string, line: number, character: number, timeoutMs?: number): Promise<LspLocation[]> {
      await ensureStarted()
      if (!child) return []
      const uri = syncDocument(file)
      const res = await request<unknown>('textDocument/definition', { textDocument: { uri }, position: { line, character } }, timeoutMs)
      return normalizeLocations(res)
    },
    async references(file: string, line: number, character: number, timeoutMs?: number): Promise<LspLocation[]> {
      await ensureStarted()
      if (!child) return []
      const uri = syncDocument(file)
      const res = await request<unknown>(
        'textDocument/references',
        { textDocument: { uri }, position: { line, character }, context: { includeDeclaration: true } },
        timeoutMs,
      )
      return normalizeLocations(res)
    },
    async close(): Promise<void> {
      if (!child) return
      const proc = child
      send({ jsonrpc: '2.0', id: nextId++, method: 'shutdown' })
      send({ jsonrpc: '2.0', method: 'exit' })
      resetState()
      const killer = setTimeout(() => {
        try {
          proc.kill()
        } catch {
          // already gone
        }
      }, 200)
      killer.unref?.()
    },
  }
}
