import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

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
export function getDiagnostics(opts: { server: LspServer; cwd: string; file: string; timeoutMs?: number }): Promise<LspDiagnostic[]> {
  return new Promise((resolve) => {
    const child = spawn(opts.server.command, opts.server.args ?? [], { cwd: opts.cwd, stdio: ['pipe', 'pipe', 'ignore'] })
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
          params: { textDocument: { uri, languageId: 'plaintext', version: 1, text } },
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
