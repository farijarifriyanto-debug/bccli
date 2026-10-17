import { randomBytes } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { contentText, type ChatMessage, type Usage } from './provider'

type SessionRecord =
  | { t: 'msg'; m: ChatMessage }
  | { t: 'reset' }
  | { t: 'usage'; inputTokens: number; outputTokens: number; cachedInputTokens?: number; cacheWriteTokens?: number; model?: string }

function projectDir(home: string, cwd: string): string {
  const slug =
    cwd
      .replace(/[^a-zA-Z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(-100) || 'root'
  return join(home, 'sessions', slug)
}

function repairTail(messages: ChatMessage[]): ChatMessage[] {
  const out = [...messages]
  for (let i = out.length - 1; i >= 0; i--) {
    const m = out[i]
    if (m.role !== 'assistant' || !m.tool_calls?.length) continue
    const answered = new Set(out.slice(i + 1).flatMap((x) => (x.role === 'tool' ? [x.tool_call_id] : [])))
    if (!m.tool_calls.every((c) => answered.has(c.id))) out.length = i
    break
  }
  return out
}

export class Session {
  constructor(readonly file: string) {}

  static create(home: string, cwd: string, now = new Date()): Session {
    const dir = projectDir(home, cwd)
    mkdirSync(dir, { recursive: true })
    const stamp = now.toISOString().replace(/[:.]/g, '-')
    return new Session(join(dir, `${stamp}-${randomBytes(3).toString('hex')}.jsonl`))
  }

  static list(home: string, cwd: string): { session: Session; mtime: Date; preview: string }[] {
    const dir = projectDir(home, cwd)
    if (!existsSync(dir)) return []
    return readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => {
        const session = new Session(join(dir, f))
        const first = session.load().find((m) => m.role === 'user')
        return { session, mtime: statSync(session.file).mtime, preview: first ? contentText(first.content).slice(0, 80) : '' }
      })
      .sort((a, b) => b.mtime.getTime() - a.mtime.getTime() || b.session.file.localeCompare(a.session.file))
  }

  static latest(home: string, cwd: string): Session | undefined {
    return Session.list(home, cwd)[0]?.session
  }

  private write(record: SessionRecord): void {
    appendFileSync(this.file, `${JSON.stringify(record)}\n`)
  }

  append(message: ChatMessage): void {
    this.write({ t: 'msg', m: message })
  }

  appendUsage(usage: Usage & { model?: string }): void {
    this.write({ t: 'usage', ...usage })
  }

  reset(): void {
    this.write({ t: 'reset' })
  }

  private records(): SessionRecord[] {
    if (!existsSync(this.file)) return []
    const out: SessionRecord[] = []
    for (const line of readFileSync(this.file, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        out.push(JSON.parse(line))
      } catch {
        // a torn line must not hide the rest of the log
      }
    }
    return out
  }

  /** What the model continues from: everything after the last reset (after a compaction that is the summary and the recent turns). */
  load(): ChatMessage[] {
    let messages: ChatMessage[] = []
    for (const record of this.records()) {
      if (record.t === 'reset') messages = []
      else if (record.t === 'msg') messages.push(record.m)
    }
    return repairTail(messages)
  }

  /**
   * What the user sees on resume: the whole conversation. Compaction only shrinks what the model is sent, so
   * its reset does not hide the older turns here. A real reset (/clear, rewind) still starts over, the
   * synthetic summary pair is never shown, and the recent turns a compaction re-writes are not shown twice.
   */
  loadHistory(): ChatMessage[] {
    const segments: ChatMessage[][] = [[]]
    for (const record of this.records()) {
      if (record.t === 'reset') segments.push([])
      else if (record.t === 'msg') segments[segments.length - 1].push(record.m)
    }
    let shown: ChatMessage[] = segments[0]
    for (const segment of segments.slice(1)) {
      if (!isCompactionSummary(segment[0])) {
        shown = segment
        continue
      }
      const kept = segment.slice(2)
      let at = 0
      while (at <= shown.length && !endsWithPrefixOf(shown, at, kept)) at++
      shown = [...shown, ...kept.slice(shown.length - at)]
    }
    return repairTail(shown.filter((m) => !isCompactionSummary(m) && !isCompactionAck(m)))
  }
}

const SUMMARY_PREFIX = 'Summary of the previous conversation:'
const SUMMARY_ACK = 'OK, I will continue from this summary.'

function isCompactionSummary(m: ChatMessage | undefined): boolean {
  return m?.role === 'user' && typeof m.content === 'string' && m.content.startsWith(SUMMARY_PREFIX)
}

function isCompactionAck(m: ChatMessage): boolean {
  return m.role === 'assistant' && m.content === SUMMARY_ACK
}

function sameMessage(a: ChatMessage, b: ChatMessage): boolean {
  if (a.role !== b.role) return false
  if (a.role === 'tool' && b.role === 'tool') return a.tool_call_id === b.tool_call_id
  return JSON.stringify(a.content) === JSON.stringify(b.content) && JSON.stringify('tool_calls' in a && a.tool_calls) === JSON.stringify('tool_calls' in b && b.tool_calls)
}

/** True when shown[at..] is exactly the start of kept: the tail a compaction wrote again. */
function endsWithPrefixOf(shown: ChatMessage[], at: number, kept: ChatMessage[]): boolean {
  const n = shown.length - at
  if (n > kept.length) return false
  for (let j = 0; j < n; j++) if (!sameMessage(shown[at + j], kept[j])) return false
  return true
}

export function pruneSessions(home: string, now = Date.now(), maxAgeDays = 30): number {
  const root = join(home, 'sessions')
  if (!existsSync(root)) return 0
  let removed = 0
  for (const project of readdirSync(root)) {
    const dir = join(root, project)
    for (const file of readdirSync(dir)) {
      const path = join(dir, file)
      if (now - statSync(path).mtimeMs > maxAgeDays * 86400_000) {
        rmSync(path)
        removed++
      }
    }
  }
  return removed
}
