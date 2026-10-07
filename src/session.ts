import { randomBytes } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { contentText, type ChatMessage } from './provider'

type SessionRecord = { t: 'msg'; m: ChatMessage } | { t: 'reset' }

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

  reset(): void {
    this.write({ t: 'reset' })
  }

  load(): ChatMessage[] {
    if (!existsSync(this.file)) return []
    let messages: ChatMessage[] = []
    for (const line of readFileSync(this.file, 'utf8').split('\n')) {
      if (!line.trim()) continue
      let record: SessionRecord
      try {
        record = JSON.parse(line)
      } catch {
        continue
      }
      if (record.t === 'reset') messages = []
      else if (record.t === 'msg') messages.push(record.m)
    }
    return repairTail(messages)
  }
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
