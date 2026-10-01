import type { AgentEvent } from '../agent'
import { t as translate } from '../i18n'

export interface SubLine {
  id: string
  tool: string
  target: string
  done: boolean
  isError?: boolean
}

export type Entry = { id: number } & (
  | { kind: 'header' }
  | { kind: 'user'; text: string }
  /** cont: continuation of the entry above (no bullet); flushed: chars of this completion already moved to scrollback. */
  | { kind: 'assistant'; text: string; cont?: boolean; flushed?: number }
  /** open: fixed state for a reprint; otherwise follows the ctrl+t toggle. */
  | { kind: 'thinking'; text: string; open?: boolean }
  | { kind: 'tool'; callId: string; tool: string; target: string; output?: string; display?: string; isError?: boolean; done: boolean; sub?: SubLine[] }
  | { kind: 'notice'; text: string; tone: 'info' | 'warn' | 'error' }
)

/** done = printed once to scrollback (Ink <Static>); live = still changing, redrawn every frame. */
export interface Transcript {
  done: Entry[]
  live: Entry[]
}

let nextId = 0
type EntryInput = Entry extends infer E ? (E extends { id: number } ? Omit<E, 'id'> : never) : never
export const entry = (e: EntryInput): Entry => ({ ...e, id: nextId++ }) as Entry

const NOTICES: Partial<Record<AgentEvent['type'], [string, 'info' | 'warn' | 'error']>> = {
  compacted: ['Conversation summarized to fit the model context.', 'info'],
  stepLimit: ['Step limit of 50 reached. Type "continue" to keep going.', 'warn'],
  aborted: ['Cancelled.', 'warn'],
}

const isEmptyCont = (e: Entry) => e.kind === 'assistant' && e.cont && !e.text

export function endTurn(t: Transcript): Transcript {
  return { done: [...t.done, ...t.live.filter((e) => !isEmptyCont(e))], live: [] }
}

// Lines that may belong to a tool call written as text: keep them live so textReplace can remove them.
const TOOL_MARKUP = /<\/?tool_call>|<\/?arg_(?:key|value)>|Tool call list|^\s*\d+\.\s*Tool:|`\s*=\s*`/

/**
 * Index of the newline ending the last complete line that is safe to print for good, or -1.
 * A code block and a run of lines with `|` (a table in the making) stay live until they end, so the whole
 * block is drawn at once: a table printed line by line can never be aligned.
 */
function finishedCut(text: string): number {
  let inFence = false
  let pos = 0
  let cut = -1
  const lines = text.split('\n')
  for (const line of lines.slice(0, -1)) {
    if (TOOL_MARKUP.test(line)) break
    if (line.trimStart().startsWith('```')) inFence = !inFence
    const tableRow = !inFence && !line.trimStart().startsWith('```') && line.includes('|') && line.trim() !== ''
    pos += line.length + 1
    if (!inFence && !tableRow) cut = pos - 1
  }
  return cut
}

// A streamed answer taller than the terminal makes Ink clear and redraw the whole screen every frame
// (scrollback lost, view jumps). Print each finished line once instead and keep only the last one live.
function flushLines(t: Transcript): Transcript {
  const last = t.live.at(-1)
  if (last?.kind !== 'assistant') return t
  const cut = finishedCut(last.text)
  if (cut < 0) return t
  const chunk = last.text.slice(0, cut)
  if (!last.cont && !chunk.trim()) return t
  const rest = entry({ kind: 'assistant', text: last.text.slice(cut + 1), cont: true, flushed: (last.flushed ?? 0) + cut + 1 })
  // An empty chunk is a blank line; a space keeps it from rendering as nothing.
  return { done: [...t.done, ...t.live.slice(0, -1).filter((e) => !isEmptyCont(e)), { ...last, text: chunk || ' ' }], live: [rest] }
}

// Keep the live region small: anything finished moves to scrollback immediately, so long turns never
// grow taller than the terminal (which makes Ink redraw the whole screen and garble scrollback).
export function applyEvent(t: Transcript, event: AgentEvent): Transcript {
  switch (event.type) {
    case 'text': {
      const last = t.live.at(-1)
      if (last?.kind === 'assistant') return flushLines({ ...t, live: [...t.live.slice(0, -1), { ...last, text: last.text + event.delta }] })
      return flushLines({ ...t, live: [...t.live, entry({ kind: 'assistant', text: event.delta })] })
    }
    case 'thinking': {
      const last = t.live.at(-1)
      if (last?.kind === 'thinking') return { ...t, live: [...t.live.slice(0, -1), { ...last, text: last.text + event.delta }] }
      return { ...t, live: [...t.live, entry({ kind: 'thinking', text: event.delta })] }
    }
    case 'textReplace': {
      const last = t.live.at(-1)
      if (last?.kind !== 'assistant') return t
      // Already-printed lines cannot be taken back; replace only what is still live.
      return { ...t, live: [...t.live.slice(0, -1), { ...last, text: event.text.slice(last.flushed ?? 0) }] }
    }
    case 'toolStart': {
      // A still-running tool means these started in parallel: keep them together in live.
      const running = t.live.some((e) => e.kind === 'tool' && !e.done)
      const tool = entry({ kind: 'tool', callId: event.id, tool: event.tool, target: event.target, done: false })
      return running ? { ...t, live: [...t.live, tool] } : { done: [...t.done, ...t.live.filter((e) => !isEmptyCont(e))], live: [tool] }
    }
    case 'toolEnd': {
      const live = t.live.map((e) =>
        e.kind === 'tool' && e.callId === event.id
          ? { ...e, output: event.output, display: event.display, isError: event.isError, done: true }
          : e,
      )
      const firstRunning = live.findIndex((e) => e.kind === 'tool' && !e.done)
      const cut = firstRunning === -1 ? live.length : firstRunning
      return { done: [...t.done, ...live.slice(0, cut)], live: live.slice(cut) }
    }
    case 'subagent': {
      const inner = event.event
      if (inner.type !== 'toolStart' && inner.type !== 'toolEnd') return t
      const update = (e: Entry): Entry => {
        if (e.kind !== 'tool' || e.callId !== event.parentId) return e
        const sub = e.sub ?? []
        if (inner.type === 'toolStart') return { ...e, sub: [...sub, { id: inner.id, tool: inner.tool, target: inner.target, done: false }] }
        return { ...e, sub: sub.map((s) => (s.id === inner.id ? { ...s, done: true, isError: inner.isError } : s)) }
      }
      return { ...t, live: t.live.map(update) }
    }
    case 'error':
      return { ...t, live: [...t.live, entry({ kind: 'notice', text: `Error: ${event.message}`, tone: 'error' })] }
    default: {
      const notice = NOTICES[event.type]
      return notice ? { ...t, live: [...t.live, entry({ kind: 'notice', text: translate(notice[0]), tone: notice[1] })] } : t
    }
  }
}
