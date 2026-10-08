import { ConfigError } from './config'
import { t } from './i18n'
import type { CommentDelivery } from './ghBotWebhook'
import { extractCommand } from './ghBotWebhook'

export interface GhBotConfig {
  enabled: boolean
  path: string
  secretEnv: string
  repos: string[]
  users: string[]
  maxBodyBytes: number
  maxActive: number
  maxQueue: number
  stepLimit: number
  timeoutMs: number
  /** Kapasitas completed-LRU (opsional; default 1000) — dipakai test utk memperkecil. */
  dedupCap?: number
}

const strArray = (v: unknown, name: string): string[] => {
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
    throw new ConfigError(t('githubBot.{name} must be an array of strings.', { name }))
  }
  return v as string[]
}
const posInt = (v: unknown, name: string, fallback: number): number => {
  if (v === undefined) return fallback
  if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) {
    throw new ConfigError(t('githubBot.{name} must be a positive integer.', { name }))
  }
  return v
}

/** Validasi ketat + default aman (off-by-default). */
export function ghBotConfigFrom(raw: unknown): GhBotConfig {
  const r = (raw ?? {}) as Record<string, unknown>
  if (r.repos !== undefined) strArray(r.repos, 'repos')
  if (r.users !== undefined) strArray(r.users, 'users')
  if (r.enabled !== undefined && typeof r.enabled !== 'boolean') {
    throw new ConfigError(t('githubBot.enabled must be a boolean.'))
  }
  if (r.path !== undefined && (typeof r.path !== 'string' || !r.path.startsWith('/') || r.path.length < 2)) {
    throw new ConfigError(t('githubBot.path must be an absolute path like /github.'))
  }
  if (r.secretEnv !== undefined && (typeof r.secretEnv !== 'string' || r.secretEnv === '')) {
    throw new ConfigError(t('githubBot.secretEnv must be a non-empty string.'))
  }
  return {
    enabled: r.enabled === true,
    path: typeof r.path === 'string' ? r.path : '/github',
    secretEnv: typeof r.secretEnv === 'string' ? r.secretEnv : 'GITHUB_WEBHOOK_SECRET',
    repos: r.repos === undefined ? [] : (r.repos as string[]),
    users: r.users === undefined ? [] : (r.users as string[]),
    maxBodyBytes: posInt(r.maxBodyBytes, 'maxBodyBytes', 1_048_576),
    maxActive: posInt(r.maxActive, 'maxActive', 1),
    maxQueue: posInt(r.maxQueue, 'maxQueue', 10),
    stepLimit: posInt(r.stepLimit, 'stepLimit', 8),
    timeoutMs: posInt(r.timeoutMs, 'timeoutMs', 120_000),
    ...(typeof r.dedupCap === 'number' && Number.isInteger(r.dedupCap) && r.dedupCap > 0 ? { dedupCap: r.dedupCap as number } : {}),
  }
}

export type AcceptResult = 'queued' | 'dedup' | 'inflight' | 'filtered' | 'full' | 'closed'

export interface GhBotHubDeps {
  out(s: string): void
  err(s: string): void
  /** SATU signal (deadline ∪ close) diteruskan ke collect+draft+post. */
  runJob(d: CommentDelivery, signal: AbortSignal): Promise<{ ok: boolean; reason?: string }>
}

export interface CloseSummary {
  aborted: number
  terminationConfirmed: number
  terminationUnconfirmed: number
}

/**
 * Admission atomik (spec §4): filter → cek duplikat (inFlight/LRU) → cek kapasitas →
 * reservasi dalam satu blok sinkron. `full` TIDAK menyimpan dedup. Worker membersihkan
 * active/inFlight di finally pada resolve MAUPUN reject (dibungkus Promise.resolve().then
 * agar throw sinkron pun masuk jalur catch). Job gagal tidak masuk completed-LRU.
 */
export class GhBotHub {
  private readonly inFlight = new Set<string>()
  private readonly completed = new Set<string>()
  private readonly completedOrder: string[] = []
  private readonly queue: CommentDelivery[] = []
  private active = 0
  private closed = false
  private closing = false
  private readonly closeController = new AbortController()
  private readonly closeReasons: string[] = []
  private readonly idleWaiters: Array<() => void> = []
  private readonly dedupCap: number
  /** Akumulasi SEMUA job (di/di luar close) — §9.19: unconfirmed terhitung walau gagal sebelum close. */
  private unconfirmedTotal = 0

  constructor(
    private readonly cfg: GhBotConfig,
    private readonly deps: GhBotHubDeps,
  ) {
    this.dedupCap = cfg.dedupCap ?? 1000
  }

  accept(delivery: CommentDelivery): AcceptResult {
    if (this.closed) return 'closed'
    // Filter SEBELUM admission (spec §4) — tanpa state.
    if (delivery.event !== 'issue_comment' || delivery.action !== 'created') return 'filtered'
    if (delivery.authorType === 'Bot') return 'filtered'
    if (!this.cfg.repos.some((r) => r.toLowerCase() === delivery.repo.toLowerCase())) return 'filtered'
    if (!this.cfg.users.some((u) => u.toLowerCase() === delivery.author.toLowerCase())) return 'filtered'
    const task = extractCommand(delivery.body)
    if (task === null) {
      if (delivery.body.trimStart().startsWith('/bccli')) {
        this.deps.err(t('Ignored empty command in delivery {id}.', { id: delivery.delivery }))
      }
      return 'filtered'
    }
    // Admisi atomik: duplikat → kapasitas → reservasi (satu blok sinkron).
    if (this.inFlight.has(delivery.delivery)) return 'inflight'
    if (this.completed.has(delivery.delivery)) return 'dedup'
    if (this.queue.length >= this.cfg.maxQueue) return 'full' // TANPA menyimpan dedup
    this.inFlight.add(delivery.delivery)
    this.queue.push(delivery)
    this.pump()
    return 'queued'
  }

  private pump(): void {
    while (!this.closed && this.active < this.cfg.maxActive && this.queue.length > 0) {
      const delivery = this.queue.shift() as CommentDelivery
      this.active++
      const signal = AbortSignal.any([AbortSignal.timeout(this.cfg.timeoutMs), this.closeController.signal])
      // Review #2: bungkus dulu — throw SINKRON masuk jalur catch, bukan meledak dari pump.
      void Promise.resolve()
        .then(() => this.deps.runJob(delivery, signal))
        .then((res) => {
          if (res.ok) this.pushCompleted(delivery.delivery)
          else {
            if (res.reason === 'termination-unconfirmed') this.unconfirmedTotal++
            if (this.closing) this.closeReasons.push(res.reason ?? 'aborted')
          }
        })
        .catch((error: unknown) => {
          const message = String((error as Error)?.message ?? error)
          this.deps.err(`gh-bot job threw: ${message}`)
          if (this.closing) this.closeReasons.push('error')
        })
        .finally(() => {
          // Revisi glue #4: SELALU — resolve sukses/gagal MAUPUN reject/throw.
          this.inFlight.delete(delivery.delivery)
          this.active--
          this.pump()
          this.maybeIdle()
        })
    }
    this.maybeIdle()
  }

  private pushCompleted(id: string): void {
    if (this.completed.has(id)) return
    this.completed.add(id)
    this.completedOrder.push(id)
    while (this.completedOrder.length > this.dedupCap) {
      const oldest = this.completedOrder.shift() as string
      this.completed.delete(oldest)
    }
  }

  private maybeIdle(): void {
    if (this.active === 0 && this.queue.length === 0) {
      while (this.idleWaiters.length > 0) (this.idleWaiters.shift() as () => void)()
    }
  }

  whenIdle(): Promise<void> {
    if (this.active === 0 && this.queue.length === 0) return Promise.resolve()
    return new Promise((resolve) => this.idleWaiters.push(resolve))
  }

  async close(): Promise<CloseSummary> {
    this.closed = true
    this.closing = true
    this.closeController.abort()
    // Buang antrian sambil menghapus ID-nya dari inFlight (lifecycle: stats nol).
    for (const abandoned of this.queue.splice(0)) this.inFlight.delete(abandoned.delivery)
    await this.whenIdle()
    const aborted = this.closeReasons.length
    const unconfirmedDuringClose = this.closeReasons.filter((r) => r === 'termination-unconfirmed').length
    const summary: CloseSummary = {
      aborted,
      terminationConfirmed: aborted - unconfirmedDuringClose,
      terminationUnconfirmed: this.unconfirmedTotal, // global — termasuk gagal sebelum close
    }
    if (summary.terminationUnconfirmed > 0) {
      this.deps.err(
        `gh-bot closed — ${aborted} active jobs aborted; termination confirmed ${summary.terminationConfirmed}, UNCONFIRMED ${summary.terminationUnconfirmed} (child may still be running)`,
      )
    }
    return summary
  }

  stats(): { queued: number; active: number; inflight: number; completed: number } {
    return {
      queued: this.queue.length,
      active: this.active,
      inflight: this.inFlight.size,
      completed: this.completed.size,
    }
  }
}
