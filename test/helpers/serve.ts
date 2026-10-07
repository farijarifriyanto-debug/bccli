import { mkdtempSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import type { Provider } from '../../src/provider'
import { type ServeHandle, startServe } from '../../src/serve'
import type { ClientFrame, ServerFrame } from '../../src/serveProtocol'

// Stub provider pola test/sdk.test.ts (WAJIB panggil req.onText agar agent emit 'text').
export function scripted(texts: string[]): Provider {
  let n = 0
  return {
    async chat(req) {
      const text = texts[Math.min(n++, texts.length - 1)]
      if (text) req.onText?.(text)
      return { text, toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } }
    },
    async listModels() {
      return ['serve-model']
    },
  }
}

export async function withServe(
  texts: string[],
  fn: (ctx: { h: ServeHandle; base: string }) => Promise<void>,
): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'bccli-serve-'))
  const cwd = mkdtempSync(join(tmpdir(), 'bccli-serve-cwd-'))
  const h = await startServe({
    port: 0,
    cwd,
    provider: scripted(texts),
    env: { BCCLI_HOME: home, BOTCONNECTOR_API_KEY: 'k' } as NodeJS.ProcessEnv,
  })
  try {
    await fn({ h, base: `http://127.0.0.1:${h.port}` })
  } finally {
    await h.close()
  }
}

export function api(
  base: string,
  token: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  })
}

/** Raw node:http request — fetch melarang header Host/Origin; trust fence butuh keduanya. */
export function raw(
  base: string,
  path: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  const u = new URL(`${base}${path}`)
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'GET', headers }, (res) => {
      let body = ''
      res.on('data', (c) => (body += c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
    })
    req.on('error', reject)
    req.end()
  })
}

export interface MuxClient {
  ws: WebSocket
  frames: ServerFrame[]
  wait: (pred: (f: ServerFrame) => boolean, ms?: number) => Promise<ServerFrame>
  send: (f: ClientFrame) => void
  items: () => { streamId: string; value: Record<string, unknown> }[]
}

export async function connectMux(h: ServeHandle): Promise<MuxClient> {
  const frames: ServerFrame[] = []
  const ws = new WebSocket(`ws://127.0.0.1:${h.port}/v1/mux`, {
    headers: { authorization: `Bearer ${h.token}` },
  })
  ws.on('message', (data) => frames.push(JSON.parse(String(data)) as ServerFrame))
  await new Promise<void>((resolve, reject) => {
    ws.on('open', () => resolve())
    ws.on('error', reject)
  })
  const wait = async (pred: (f: ServerFrame) => boolean, ms = 8000): Promise<ServerFrame> => {
    const deadline = Date.now() + ms
    for (;;) {
      const hit = frames.find(pred)
      if (hit) return hit
      if (Date.now() > deadline) throw new Error(`timeout menunggu frame; terkirim ${JSON.stringify(frames)}`)
      await new Promise((r) => setTimeout(r, 10))
    }
  }
  return {
    ws,
    frames,
    wait,
    send: (f) => ws.send(JSON.stringify(f)),
    items: () =>
      frames
        .filter((f) => f.type === 'item')
        .map((f) => ({ streamId: f.streamId, value: (f as { value: Record<string, unknown> }).value })),
  }
}

export const isItem = (type: string) => (f: ServerFrame): boolean =>
  f.type === 'item' && (f as { value: { type?: string } }).value?.type === type
