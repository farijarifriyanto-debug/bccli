import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { estimateTokens } from './tokenBudget'
import { t } from './i18n'

export interface StatsRow {
  project: string
  sessions: number
  messages: number
  /** Estimated tokens (messages without recorded usage only). */
  inputTokens: number
  outputTokens: number
  /** Tokens from persisted `t:usage` records. */
  usageInputTokens: number
  usageOutputTokens: number
  cachedInputTokens: number
  cacheWriteTokens: number
  toolCalls: Record<string, number>
  /** Total tokens per session (recorded basis when present, estimate otherwise). */
  sessionTotals: number[]
  /** Per-model token totals from `t:usage` records that carry a model ref. */
  modelUsage: Record<string, ModelTotals>
}

export interface ModelTotals {
  turns: number
  inputTokens: number
  outputTokens: number
  cachedInputTokens: number
  cacheWriteTokens: number
}

export interface AggregateOptions {
  days: number
  now?: number
}

interface UsageRecord {
  t: 'usage'
  inputTokens: number
  outputTokens: number
  cachedInputTokens?: number
  cacheWriteTokens?: number
  model?: string
}

function isUsageRecord(value: unknown): value is UsageRecord {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return v.t === 'usage' && typeof v.inputTokens === 'number' && typeof v.outputTokens === 'number'
}

interface MsgRecord {
  t: 'msg'
  m: { role?: string; content?: unknown; tool_calls?: Array<{ function?: { name?: string } }> }
}

function isMsgRecord(value: unknown): value is MsgRecord {
  if (!value || typeof value !== 'object') return false
  const v = value as { t?: string; m?: unknown }
  return v.t === 'msg' && !!v.m
}

function emptyRow(project: string): StatsRow {
  return {
    project,
    sessions: 0,
    messages: 0,
    inputTokens: 0,
    outputTokens: 0,
    usageInputTokens: 0,
    usageOutputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    toolCalls: {},
    sessionTotals: [],
    modelUsage: {},
  }
}

/**
 * Walk home/sessions/<project>/*.jsonl, keep files with mtime within `days`,
 * and aggregate per project. Token basis switches per session: sessions with
 * recorded usage records use them (incl. cache counters); older sessions fall
 * back to ~4 chars/token estimates from message content.
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
        row = emptyRow(project)
        byProject.set(project, row)
      }
      row.sessions++
      let usageIn = 0
      let usageOut = 0
      let cachedIn = 0
      let cacheWrite = 0
      let usageCount = 0
      let estIn = 0
      let estOut = 0
      let messages = 0
      const tools: Record<string, number> = {}
      for (const line of readFileSync(path, 'utf8').split('\n')) {
        if (!line.trim()) continue
        let record: unknown
        try {
          record = JSON.parse(line)
        } catch {
          continue
        }
        if (isUsageRecord(record)) {
          usageIn += record.inputTokens
          usageOut += record.outputTokens
          cachedIn += record.cachedInputTokens ?? 0
          cacheWrite += record.cacheWriteTokens ?? 0
          usageCount++
          if (record.model) {
            let mt = row.modelUsage[record.model]
            if (!mt) {
              mt = { turns: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0 }
              row.modelUsage[record.model] = mt
            }
            mt.turns++
            mt.inputTokens += record.inputTokens
            mt.outputTokens += record.outputTokens
            mt.cachedInputTokens += record.cachedInputTokens ?? 0
            mt.cacheWriteTokens += record.cacheWriteTokens ?? 0
          }
          continue
        }
        if (!isMsgRecord(record)) continue
        messages++
        if (record.m.role === 'user' || record.m.role === 'assistant') {
          const text = typeof record.m.content === 'string' ? record.m.content : JSON.stringify(record.m.content ?? '')
          const tokens = estimateTokens(text)
          if (record.m.role === 'user') estIn += tokens
          else estOut += tokens
        }
        if (record.m.role === 'assistant') {
          for (const call of record.m.tool_calls ?? []) {
            const name = call?.function?.name
            if (typeof name === 'string' && name) tools[name] = (tools[name] ?? 0) + 1
          }
        }
      }
      row.messages += messages
      if (usageCount > 0) {
        row.usageInputTokens += usageIn
        row.usageOutputTokens += usageOut
        row.cachedInputTokens += cachedIn
        row.cacheWriteTokens += cacheWrite
        row.sessionTotals.push(usageIn + usageOut + cachedIn + cacheWrite)
      } else {
        row.inputTokens += estIn
        row.outputTokens += estOut
        row.sessionTotals.push(estIn + estOut)
      }
      for (const [name, count] of Object.entries(tools)) row.toolCalls[name] = (row.toolCalls[name] ?? 0) + count
    }
  }
  return [...byProject.values()].sort((a, b) => b.messages - a.messages || a.project.localeCompare(b.project))
}

/** Compact token formatting like the opencode stats boxes: 291.6K / 41.0M / 627.4M. */
export function fmtCompact(n: number): string {
  if (n < 1000) return String(Math.round(n))
  const units: Array<[number, string]> = [
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'K'],
  ]
  for (const [size, suffix] of units) {
    if (n >= size) return `${(n / size).toFixed(1)}${suffix}`
  }
  return String(Math.round(n))
}

function fmtCount(n: number): string {
  return n.toLocaleString('en-US')
}

function median(values: number[]): number {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

const BOX_INNER = 46

function border(left: string, right: string): string {
  return `${left}${'─'.repeat(BOX_INNER + 2)}${right}`
}

function center(text: string): string {
  const pad = Math.max(0, BOX_INNER - text.length)
  const left = Math.floor(pad / 2)
  return `│${' '.repeat(left)}${text}${' '.repeat(pad - left)}│`
}

function contentLine(content: string): string {
  return `│${content}${' '.repeat(Math.max(1, BOX_INNER + 1 - content.length))}│`
}

function valueLine(label: string, value: string): string {
  return contentLine(` ${label}${' '.repeat(Math.max(1, BOX_INNER - 1 - label.length - value.length))}${value}`)
}

function box(title: string, rows: Array<[string, string]>): string[] {
  return [border('┌', '┐'), center(title), border('├', '┤'), ...rows.map(([l, v]) => valueLine(l, v)), border('└', '┘')]
}

/** Truncate long names the way opencode does (`memory_add_obser..`). */
function truncateName(name: string): string {
  return name.length > 18 ? `${name.slice(0, 16)}..` : name
}

function toolBox(tools: Array<[string, number]>): string[] {
  const total = tools.reduce((sum, [, n]) => sum + n, 0)
  const max = tools[0]?.[1] ?? 1
  const lines = tools.map(([name, count]) => {
    const blocks = Math.max(1, Math.round((count / max) * 20))
    const pct = ((count / total) * 100).toFixed(1).padStart(5)
    return contentLine(` ${truncateName(name).padEnd(16)} ${'█'.repeat(blocks).padEnd(20)} ${count} (${pct}%)`)
  })
  return [border('┌', '┐'), center('TOOL USAGE'), border('├', '┤'), ...lines, border('└', '┘')]
}

function modelBox(models: Array<[string, ModelTotals]>): string[] {
  const lines: string[] = []
  for (let i = 0; i < models.length; i++) {
    const [name, m] = models[i]
    if (i > 0) lines.push(border('├', '┤'))
    lines.push(contentLine(` ${truncateName(name)}`))
    lines.push(valueLine(' Turns', fmtCount(m.turns)))
    lines.push(valueLine(' Input Tokens', fmtCompact(m.inputTokens)))
    lines.push(valueLine(' Output Tokens', fmtCompact(m.outputTokens)))
    lines.push(valueLine(' Cache Read', fmtCompact(m.cachedInputTokens)))
    lines.push(valueLine(' Cache Write', fmtCompact(m.cacheWriteTokens)))
  }
  return [border('┌', '┐'), center('MODEL USAGE'), border('├', '┤'), ...lines, border('└', '┘')]
}

export interface StatsCliArgs {
  subArgs: string[]
  home: string
  cwd?: string
  now?: number
  /** Already-parsed `--days` from parseCliArgs (subArgs never contains it). */
  days?: number
  /** Already-parsed `--tools` top-N cap. */
  tools?: number
  /** Already-parsed `--models` ("all" or a number as string). */
  models?: string
  /** Already-parsed `--project` filter (empty string = current project). */
  project?: string
}

export interface StatsDeps {
  out(line: string): void
  err?(line: string): void
}

function projectSlug(cwd: string): string {
  return (
    cwd
      .replace(/[^a-zA-Z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(-100) || 'root'
  )
}

/**
 * `bccli stats [--days N] [--tools N] [--models [N|all]] [--project slug]` —
 * token usage and tool-call stats from local session files, rendered as
 * opencode-style overview/tokens/model/tool boxes.
 */
export function runStatsCommand(args: StatsCliArgs, deps: StatsDeps): number {
  let days = args.days ?? 7
  let toolsCap = args.tools
  let modelsFlag = args.models
  let projectFilter = args.project
  const rest = args.subArgs
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]
    if (a === '--days' || a === '--tools' || a === '--models' || a === '--project') {
      const raw = rest[++i] ?? ''
      if (a === '--days') {
        const n = Number(raw)
        if (!Number.isInteger(n) || n < 1) {
          deps.err?.(t('--days must be a positive integer'))
          return 1
        }
        days = n
      } else if (a === '--tools') {
        const n = Number(raw)
        if (!Number.isInteger(n) || n < 1) {
          deps.err?.(t('--tools must be a positive integer'))
          return 1
        }
        toolsCap = n
      } else if (a === '--models') {
        if (raw === '' || raw === 'all' || raw.startsWith('-')) {
          modelsFlag = 'all'
          if (raw.startsWith('-')) i--
        } else {
          const n = Number(raw)
          if (!Number.isInteger(n) || n < 1) {
            deps.err?.(t('--models must be a positive integer or "all"'))
            return 1
          }
          modelsFlag = raw
        }
      } else {
        projectFilter = raw
      }
    } else if (a.startsWith('--days=')) {
      const n = Number(a.slice('--days='.length))
      if (!Number.isInteger(n) || n < 1) {
        deps.err?.(t('--days must be a positive integer'))
        return 1
      }
      days = n
    } else if (a.startsWith('--tools=')) {
      const n = Number(a.slice('--tools='.length))
      if (!Number.isInteger(n) || n < 1) {
        deps.err?.(t('--tools must be a positive integer'))
        return 1
      }
      toolsCap = n
    } else if (a.startsWith('--models=')) {
      const raw = a.slice('--models='.length)
      if (raw === '' || raw === 'all') {
        modelsFlag = 'all'
      } else {
        const n = Number(raw)
        if (!Number.isInteger(n) || n < 1) {
          deps.err?.(t('--models must be a positive integer or "all"'))
          return 1
        }
        modelsFlag = raw
      }
    } else if (a.startsWith('--project=')) {
      projectFilter = a.slice('--project='.length)
    }
  }
  let rows = aggregateSessions(args.home, { days, now: args.now })
  if (projectFilter !== undefined) {
    const needle = projectFilter === '' ? projectSlug(args.cwd ?? '') : projectFilter
    rows = rows.filter((r) => r.project.includes(needle))
  }
  if (!rows.length) {
    deps.out(t('no sessions in the last {days} day(s)', { days: String(days) }))
    return 0
  }
  const sessions = rows.reduce((s, r) => s + r.sessions, 0)
  const messages = rows.reduce((s, r) => s + r.messages, 0)
  const input = rows.reduce((s, r) => s + r.inputTokens + r.usageInputTokens, 0)
  const output = rows.reduce((s, r) => s + r.outputTokens + r.usageOutputTokens, 0)
  const cachedIn = rows.reduce((s, r) => s + r.cachedInputTokens, 0)
  const cacheWrite = rows.reduce((s, r) => s + r.cacheWriteTokens, 0)
  const totals = rows.flatMap((r) => r.sessionTotals)
  const avg = totals.length ? totals.reduce((s, n) => s + n, 0) / totals.length : 0
  const tools: Record<string, number> = {}
  for (const r of rows) for (const [name, count] of Object.entries(r.toolCalls)) tools[name] = (tools[name] ?? 0) + count
  const modelUsage: Record<string, ModelTotals> = {}
  for (const r of rows) {
    for (const [name, m] of Object.entries(r.modelUsage)) {
      let mt = modelUsage[name]
      if (!mt) {
        mt = { turns: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0 }
        modelUsage[name] = mt
      }
      mt.turns += m.turns
      mt.inputTokens += m.inputTokens
      mt.outputTokens += m.outputTokens
      mt.cachedInputTokens += m.cachedInputTokens
      mt.cacheWriteTokens += m.cacheWriteTokens
    }
  }

  for (const line of box('OVERVIEW', [
    ['Sessions', fmtCount(sessions)],
    ['Messages', fmtCount(messages)],
    ['Days', String(days)],
  ])) deps.out(line)
  deps.out('')
  for (const line of box('TOKENS', [
    ['Input', fmtCompact(input)],
    ['Output', fmtCompact(output)],
    ['Cache Read', fmtCompact(cachedIn)],
    ['Cache Write', fmtCompact(cacheWrite)],
    ['Avg Tokens/Session', fmtCompact(avg)],
    ['Median Tokens/Session', fmtCompact(median(totals))],
  ])) deps.out(line)
  if (modelsFlag !== undefined) {
    let modelEntries = Object.entries(modelUsage).sort(
      (a, b) => b[1].inputTokens + b[1].outputTokens - (a[1].inputTokens + a[1].outputTokens) || a[0].localeCompare(b[0]),
    )
    if (modelsFlag !== 'all') modelEntries = modelEntries.slice(0, Number(modelsFlag))
    if (modelEntries.length) {
      deps.out('')
      for (const line of modelBox(modelEntries)) deps.out(line)
    }
  }
  let toolEntries = Object.entries(tools).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  if (toolsCap !== undefined) toolEntries = toolEntries.slice(0, toolsCap)
  if (toolEntries.length) {
    deps.out('')
    for (const line of toolBox(toolEntries)) deps.out(line)
  }
  deps.out('')
  deps.out(t('sessions (last {days} day(s)):', { days: String(days) }))
  for (const r of rows) {
    const inputTotal = r.inputTokens + r.usageInputTokens
    const outputTotal = r.outputTokens + r.usageOutputTokens
    deps.out(`${r.project}  ${r.sessions} ${t('session(s)')}  ${r.messages} ${t('message(s)')}  ${fmtCompact(inputTotal)}in/${fmtCompact(outputTotal)}out`)
  }
  return 0
}
