import { randomBytes, timingSafeEqual } from 'node:crypto'

/** Wire frames of the /v1/mux WebSocket (subset of the DSH stream protocol). */
export type ClientFrame = { type: 'open'; streamId: string; target: string } | { type: 'cancel'; streamId: string }
export type ServerFrame =
  | { type: 'item'; streamId: string; value: unknown }
  | { type: 'end'; streamId: string }
  | { type: 'error'; streamId: string; message: string }

/** Uplink frame size limit; oversized frames error their stream without closing the socket. */
export const MAX_FRAME_BYTES = 262144

/**
 * Parses one uplink mux frame. Malformed JSON, unknown types, an empty streamId,
 * or an `open` without a target produce `{ error }` instead of throwing.
 */
export function parseClientFrame(raw: string): ClientFrame | { error: string } {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return { error: 'invalid JSON frame' }
  }
  const f = value as { type?: unknown; streamId?: unknown; target?: unknown }
  if (typeof f?.streamId !== 'string' || f.streamId === '') return { error: 'frame requires a streamId' }
  if (f.type === 'open') {
    if (typeof f.target !== 'string' || f.target === '') return { error: 'open requires a target' }
    return { type: 'open', streamId: f.streamId, target: f.target }
  }
  if (f.type === 'cancel') return { type: 'cancel', streamId: f.streamId }
  return { error: `unknown frame type: ${String(f?.type)}` }
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

/**
 * DSH-style trust fence: loopback Host with a port matching the listener, a
 * same-machine Origin when attached, and no cross-site sec-fetch-site. Returns
 * null when trusted, else the 403 reason. Never establishes identity — the
 * bearer token does.
 */
export function trustFence(
  headers: { host?: string; origin?: string; 'sec-fetch-site'?: string },
  port: number,
): string | null {
  const host = headers.host
  if (!host) return 'missing Host header'
  const sep = host.lastIndexOf(':')
  const hostname = sep > -1 ? host.slice(0, sep) : host
  const hostPort = sep > -1 ? Number(host.slice(sep + 1)) : 80
  if (!LOOPBACK_HOSTS.has(hostname)) return `non-loopback Host: ${hostname}`
  if (hostPort !== port) return `Host port ${hostPort} does not match listener ${port}`
  if (headers.origin) {
    let origin: URL
    try {
      origin = new URL(headers.origin)
    } catch {
      return 'malformed Origin header'
    }
    const originHost = origin.hostname === '::1' ? '[::1]' : origin.hostname
    const originPort = origin.port ? Number(origin.port) : origin.protocol === 'https:' ? 443 : 80
    if (!LOOPBACK_HOSTS.has(originHost)) return `cross-origin Origin: ${headers.origin}`
    if (originPort !== port) return 'Origin port mismatch'
  }
  if (headers['sec-fetch-site'] === 'cross-site') return 'cross-site request'
  return null
}

/** Timing-safe `Authorization: Bearer <token>` check. */
export function bearerOk(header: string | undefined, token: string): boolean {
  if (!header?.startsWith('Bearer ')) return false
  const got = Buffer.from(header.slice(7))
  const want = Buffer.from(token)
  return got.length === want.length && timingSafeEqual(got, want)
}

/** Fresh 32-byte hex serve token. */
export function randomToken(): string {
  return randomBytes(32).toString('hex')
}
