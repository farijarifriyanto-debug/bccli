import type { AgentEvent } from '../agent'

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
  | { kind: 'assistant'; text: string }
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
  compacted: ['Percakapan diringkas agar muat di konteks model.', 'info'],
  stepLimit: ['Batas 50 langkah tercapai. Ketik "lanjut" untuk meneruskan.', 'warn'],
  aborted: ['Dibatalkan.', 'warn'],
}

export function endTurn(t: Transcript): Transcript {
  return { done: [...t.done, ...t.live], live: [] }
}

// Keep the live region small: anything finished moves to scrollback immediately, so long turns never
// grow taller than the terminal (which makes Ink redraw the whole screen and garble scrollback).
export function applyEvent(t: Transcript, event: AgentEvent): Transcript {
  switch (event.type) {
    case 'text': {
      const last = t.live.at(-1)
      if (last?.kind === 'assistant') return { ...t, live: [...t.live.slice(0, -1), { ...last, text: last.text + event.delta }] }
      return { ...t, live: [...t.live, entry({ kind: 'assistant', text: event.delta })] }
    }
    case 'thinking': {
      const last = t.live.at(-1)
      if (last?.kind === 'thinking') return { ...t, live: [...t.live.slice(0, -1), { ...last, text: last.text + event.delta }] }
      return { ...t, live: [...t.live, entry({ kind: 'thinking', text: event.delta })] }
    }
    case 'textReplace': {
      const last = t.live.at(-1)
      if (last?.kind !== 'assistant') return t
      return { ...t, live: [...t.live.slice(0, -1), { ...last, text: event.text }] }
    }
    case 'toolStart': {
      // A still-running tool means these started in parallel: keep them together in live.
      const running = t.live.some((e) => e.kind === 'tool' && !e.done)
      const tool = entry({ kind: 'tool', callId: event.id, tool: event.tool, target: event.target, done: false })
      return running ? { ...t, live: [...t.live, tool] } : { done: [...t.done, ...t.live], live: [tool] }
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
      return notice ? { ...t, live: [...t.live, entry({ kind: 'notice', text: notice[0], tone: notice[1] })] } : t
    }
  }
}
