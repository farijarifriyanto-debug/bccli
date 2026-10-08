import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { parseCliArgs } from './args'
import { type GhBotConfig, GhBotHub, type CloseSummary } from './ghBotDispatch'
import { t } from './i18n'
import type { Provider } from './provider'
import { LOOPBACK_BIND } from './serveProtocol'
import {
  collectGhContext,
  createDraftCollector,
  createGhSpawn,
  ghSystemPrompt,
  postReply,
  runDraft,
  type GhDeps,
} from './ghBotRunner'
import { createRuntime } from './setup'
import { verifyAndParse, type CommentDelivery } from './ghBotWebhook'

export interface GhBotServeOptions {
  port?: number
  host?: string
  config: GhBotConfig
  /** Aksesor per-request (rotasi secret tanpa restart — spec §3). */
  getSecret: () => string | undefined
  env?: NodeJS.ProcessEnv
  provider?: Provider
  fetch?: typeof globalThis.fetch
  gh?: GhDeps
  out?: (s?: string) => void
  err?: (s?: string) => void
}

export interface GhBotHandle {
  port: number
  close(): Promise<CloseSummary>
}

function json(res: ServerResponse, status: number, message: string): void {
  const body = JSON.stringify({ error: { message } })
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

function readBodyBounded(req: IncomingMessage, maxBytes: number): Promise<{ buf: Buffer; tooLarge: boolean }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let tooLarge = false
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > maxBytes) tooLarge = true
      else chunks.push(c) // di atas batas: berhenti menampung (drain saja)
    })
    req.on('end', () => resolve({ buf: Buffer.concat(chunks), tooLarge }))
    req.on('error', reject)
  })
}

/**
 * Glue NYATA (spec §6): satu signal (deadline ∪ close) melewati collect → draft → post.
 * gh asinkron via createGhSpawn; factory runtime nyata tanpa `as never`.
 */
function makeRunJob(
  o: GhBotServeOptions,
  cfg: GhBotConfig,
): (d: CommentDelivery, signal: AbortSignal) => Promise<{ ok: boolean; reason?: string }> {
  const gh: GhDeps = o.gh ?? { spawn: createGhSpawn() } // objek GhDeps (review #1)
  return async (d, signal) => {
    try {
      const ctx = await collectGhContext(d, { gh, signal })
      if (!ctx.ok) {
        o.err?.(`gh-bot collect failed (${d.repo}#${d.number}): ${ctx.reason}`)
        return { ok: false, reason: ctx.reason }
      }
      const draft = await runDraft(ctx.context, signal, {
        system: ghSystemPrompt(),
        createAgent: () => {
          const rt = createRuntime({
            cwd: process.cwd(),
            args: parseCliArgs([]),
            env: o.env,
            provider: o.provider,
            fetch: o.fetch ?? globalThis.fetch, // injectable (review #3)
            maxSteps: cfg.stepLimit, // knob yang benar-benar dipakai Agent
          })
          rt.agent.setSystemPrompt(ghSystemPrompt()) // via API agent
          rt.agent.setTools([]) // MCP TIDAK pernah start — sumber tool nol
          const collector = createDraftCollector()
          rt.agent.onEvent = (e) => collector.onEvent(e)
          return {
            run: async (prompt: string, sig: AbortSignal) => {
              rt.agent.setTools([]) // assert ulang tepat sebelum run (anti mutasi antar-turn)
              const fresh = createDraftCollector() // per-turn: teks & terminal segar
              rt.agent.onEvent = (e) => fresh.onEvent(e)
              await rt.agent.run(prompt, sig)
              return fresh.result()
            },
            dispose: async () => {
              await rt.mcp.stop() // API nyata McpManager.stop (idempoten)
              rt.agent.setTools([]) // penutup: nol tool tersisa
            },
          }
        },
      })
      if (!draft.ok) {
        o.err?.(`gh-bot draft failed (${d.repo}#${d.number}): ${draft.reason}`)
        return { ok: false, reason: draft.reason } // gagal → TANPA post
      }
      const post = await postReply(d, draft.text, { gh, signal })
      if (!post.ok) {
        o.err?.(`gh-bot post failed (${d.repo}#${d.number}): ${post.reason}`)
        return { ok: false, reason: post.reason } // termination-unconfirmed DITERUSKAN
      }
      return { ok: true }
    } catch (error) {
      const reason = (error as { reason?: string }).reason // pertahankan reason terstruktur
      o.err?.(`gh-bot job failed: ${String((error as Error)?.message ?? error)}`)
      return { ok: false, reason: reason ?? 'error' }
    }
  }
}

export async function startGhBot(opts: GhBotServeOptions): Promise<GhBotHandle> {
  const host = opts.host ?? '127.0.0.1'
  if (!LOOPBACK_BIND.has(host)) throw new Error(`gh-bot refuses non-loopback --host ${host} (loopback only)`)
  if (opts.config.enabled && !opts.getSecret()) {
    // Fail-loud: nama env TANPA nilai secret (spec §2).
    throw new Error(t('githubBot secret env {env} is empty — set it before enabling the bot.', { env: opts.config.secretEnv }))
  }
  const out = opts.out ?? ((s?: string) => console.log(s ?? ''))
  const err = opts.err ?? ((s?: string) => console.error(s ?? ''))
  const hub = new GhBotHub(opts.config, { out, err, runJob: makeRunJob(opts, opts.config) })

  const server: Server = createServer((req, res) => {
    void handle(req, res)
  })

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = (req.url ?? '').split('?')[0]
    if (path !== opts.config.path || !opts.config.enabled) {
      json(res, 404, 'not found')
      return
    }
    if (req.method !== 'POST') {
      json(res, 405, 'method not allowed')
      return
    }
    const contentType = req.headers['content-type']
    if (typeof contentType !== 'string' || !contentType.toLowerCase().includes('application/json')) {
      json(res, 415, 'content-type must be application/json')
      return
    }
    const { buf, tooLarge } = await readBodyBounded(req, opts.config.maxBodyBytes)
    if (tooLarge) {
      json(res, 413, 'body exceeds maxBodyBytes')
      return
    }
    const outcome = verifyAndParse(
      buf,
      req.headers as Record<string, string | undefined>,
      { method: 'POST', contentType, maxBodyBytes: opts.config.maxBodyBytes, getSecret: opts.getSecret },
    )
    if (!outcome.ok) {
      json(res, outcome.status, outcome.message)
      return
    }
    const accepted = hub.accept(outcome.delivery)
    if (accepted === 'full' || accepted === 'closed') {
      json(res, 503, accepted === 'full' ? 'queue full — redeliver manually later' : 'shutting down')
      return
    }
    json(res, 202, 'accepted')
  }

  await new Promise<void>((resolve) => server.listen(opts.port ?? 18790, host === 'localhost' ? '127.0.0.1' : host, resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return {
    port,
    close: async () => {
      // Stop terima request DULU → baru tutup hub (spec §5).
      await new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
      return hub.close()
    },
  }
}
