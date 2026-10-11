import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { estimateTokens } from './tokenBudget'
import { t } from './i18n'

export interface StatsRow {
  project: string
  sessions: number
  messages: number
  inputTokens: number
  outputTokens: number
  usageInputTokens: number
  usageOutputTokens: number
}

export interface AggregateOptions {
  days: number
  now?: number
}

interface UsageRecord {
  t: 'usage'
  inputTokens: number
  outputTokens: number
}

function isUsageRecord(value: unknown): value is UsageRecord {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return v.t === 'usage' && typeof v.inputTokens === 'number' && typeof v.outputTokens === 'number'
}

/**
 * Walk home/sessions/&lt;project&gt;/*.jsonl, keep files with mtime within `days`,
 * and aggregate per project: session count, message count, estimated
 * tokens from content (~4 chars/token), plus any explicit usage records.
 */
export function aggregateSessions(home: string, opts: AggregateOptions): StatsRow[] {
  const now = opts.now ?? Date.now()
  const cutoff = now - opts.days * 86400_000
  const root = join(home, 'sessions')
  if (!existsSync(root)) return []
  const byProject = new Map<string, StatsRow>()
  for (const project of readdirSync(root)) {
    const dir = join(root, project)
    let st: ReturnType<typeof statSync>
    try {
      st = statSync(dir)
    } catch {
      continue
    }
    if (!st.isDirectory()) continue
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.jsonl')) continue
      const path = join(dir, file)
      let fst: ReturnType<typeof statSync>
      try {
        fst = statSync(path)
      } catch {
        continue
      }
      if (fst.mtimeMs < cutoff) continue
      let row = byProject.get(project)
      if (!row) {
        row = { project, sessions: 0, messages: 0, inputTokens: 0, outputTokens: 0, usageInputTokens: 0, usageOutputTokens: 0 }
        byProject.set(project, row)
      }
      row.sessions++
      for (const line of readFileSync(path, 'utf8').split('\n')) {
        if (!line.trim()) continue
        let record: unknown
        try {
          record = JSON.parse(line)
        } catch {
          continue
        }
        if (isUsageRecord(record)) {
          row.usageInputTokens += record.inputTokens
          row.usageOutputTokens += record.outputTokens
          continue
        }
        const r = record as { t?: string; m?: { role?: string; content?: unknown } }
        if (r?.t !== 'msg' || !r.m) continue
        row.messages++
        const text = typeof r.m.content === 'string' ? r.m.content : JSON.stringify(r.m.content ?? '')
        const tokens = estimateTokens(text)
        if (r.m.role === 'user') row.inputTokens += tokens
        else if (r.m.role === 'assistant') row.outputTokens += tokens
      }
    }
  }
  return [...byProject.values()].sort((a, b) => b.messages - a.messages || a.project.localeCompare(b.project))
}

export interface StatsCliArgs {
  subArgs: string[]
  home: string
  now?: number
  /** Already-parsed `--days` from parseCliArgs (subArgs never contains it). */
  days?: number
}

export interface StatsDeps {
  out(line: string): void
  err?(line: string): void
}

/**
 * `bccli stats [--days N]` — token usage estimated from local session files.
 */
export function runStatsCommand(args: StatsCliArgs, deps: StatsDeps): number {
  let days = args.days ?? 7
  const rest = args.subArgs
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--days') {
      const raw = rest[++i]
      const n = Number(raw)
      if (!Number.isInteger(n) || n < 1) {
        deps.err?.(t('--days must be a positive integer'))
        return 1
      }
      days = n
    } else if (rest[i].startsWith('--days=')) {
      const n = Number(rest[i].slice('--days='.length))
      if (!Number.isInteger(n) || n < 1) {
        deps.err?.(t('--days must be a positive integer'))
        return 1
      }
      days = n
    }
  }
  const rows = aggregateSessions(args.home, { days, now: args.now })
  if (!rows.length) {
    deps.out(t('no sessions in the last {days} day(s)', { days: String(days) }))
    return 0
  }
  deps.out(t('sessions (last {days} day(s)):', { days: String(days) }))
  for (const r of rows) {
    const usage = r.usageInputTokens + r.usageOutputTokens > 0 ? ` ${t('recorded')}: ${r.usageInputTokens}in/${r.usageOutputTokens}out` : ''
    deps.out(`${r.project}  ${r.sessions} ${t('session(s)')}  ${r.messages} ${t('message(s)')}  ~${r.inputTokens}in/~${r.outputTokens}out${usage}`)
  }
  return 0
}
