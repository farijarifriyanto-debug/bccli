import { appendFileSync, mkdtempSync, readFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import type { ResponseOutputItem } from 'openai/resources/responses/responses'
import { pruneSessions, Session } from '../src/session'
import type { ChatMessage } from '../src/provider'

const home = () => mkdtempSync(join(tmpdir(), 'bccli-s-'))

test('append/load round trip; reset starts over; partial lines are skipped', () => {
  const h = home()
  const s = Session.create(h, '/work/app')
  s.append({ role: 'user', content: 'old' })
  s.reset()
  s.append({ role: 'user', content: 'hi' })
  s.append({ role: 'assistant', content: 'yo' })
  appendFileSync(s.file, '{"t":"msg","m":{"role":"us')
  expect(s.load()).toEqual([
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'yo' },
  ])
})

test('session preserves Luna PTC replay metadata for resume', () => {
  const s = Session.create(home(), '/w')
  const caller = { type: 'program' as const, caller_id: 'call_prog_1' }
  s.append({ role: 'user', content: 'compare' })
  s.append({
    role: 'assistant',
    content: null,
    tool_calls: [
      {
        id: 'call_child_1',
        type: 'function',
        function: { name: 'read', arguments: '{"path":"a.txt"}' },
        caller,
      },
    ],
    responses_output_items: [
      {
        type: 'program',
        id: 'prog_1',
        call_id: 'call_prog_1',
        code: 'const x = await tools.read({path:"a.txt"}); text(x);',
        fingerprint: 'opaque_fp_1',
      },
      {
        type: 'function_call',
        id: 'fc_1',
        call_id: 'call_child_1',
        name: 'read',
        arguments: '{"path":"a.txt"}',
        caller,
        status: 'completed',
      },
    ] as unknown as ResponseOutputItem[],
  })
  s.append({
    role: 'tool',
    tool_call_id: 'call_child_1',
    content: 'hello',
    responses_caller: caller,
  })

  const loaded = s.load()
  expect(loaded[1]).toMatchObject({
    role: 'assistant',
    responses_output_items: [
      { type: 'program', call_id: 'call_prog_1', fingerprint: 'opaque_fp_1' },
      { type: 'function_call', call_id: 'call_child_1', caller },
    ],
  })
  expect(loaded[2]).toEqual({
    role: 'tool',
    tool_call_id: 'call_child_1',
    content: 'hello',
    responses_caller: caller,
  })
})

test('load drops a trailing assistant tool call without results (crash mid-tool)', () => {
  const s = Session.create(home(), '/w')
  s.append({ role: 'user', content: 'go' })
  s.append({ role: 'assistant', content: null, tool_calls: [{ id: 'a', type: 'function', function: { name: 'bash', arguments: '{}' } }] })
  expect(s.load()).toEqual([{ role: 'user', content: 'go' }])
})

test('session round-trip preserves Luna PTC replay metadata', () => {
  const s = Session.create(home(), '/ptc')
  const caller = { type: 'program' as const, caller_id: 'call_prog_1' }
  const assistant: ChatMessage = {
    role: 'assistant',
    content: null,
    tool_calls: [
      {
        id: 'call_child_1',
        type: 'function',
        function: { name: 'read', arguments: '{"path":"a.txt"}' },
        caller,
      },
    ],
    responses_output_items: [
      {
        type: 'program',
        id: 'prog_1',
        call_id: 'call_prog_1',
        code: 'const x = await tools.read({path:"a.txt"}); text(x);',
        fingerprint: 'opaque_fp_1',
      },
      {
        type: 'function_call',
        id: 'fc_1',
        call_id: 'call_child_1',
        name: 'read',
        arguments: '{"path":"a.txt"}',
        caller,
        status: 'completed',
      },
    ] as unknown as ResponseOutputItem[],
  }
  const tool: ChatMessage = {
    role: 'tool',
    tool_call_id: 'call_child_1',
    content: 'hello',
    responses_caller: caller,
  }
  s.append({ role: 'user', content: 'read and reduce' })
  s.append(assistant)
  s.append(tool)
  expect(s.load()).toEqual([{ role: 'user', content: 'read and reduce' }, assistant, tool])
})

test('latest and list are per project, newest first', () => {
  const h = home()
  const a = Session.create(h, '/p', new Date('2026-01-01'))
  a.append({ role: 'user', content: 'first task' })
  const b = Session.create(h, '/p', new Date('2026-01-02'))
  b.append({ role: 'user', content: 'second task' })
  Session.create(h, '/other').append({ role: 'user', content: 'x' })
  utimesSync(a.file, new Date('2026-01-01'), new Date('2026-01-01'))
  expect(Session.latest(h, '/p')?.file).toBe(b.file)
  expect(Session.list(h, '/p').map((x) => x.preview)).toEqual(['second task', 'first task'])
})

test('pruneSessions removes files older than 30 days', () => {
  const h = home()
  const s = Session.create(h, '/p')
  s.append({ role: 'user', content: 'x' })
  const old = new Date(Date.now() - 31 * 86400_000)
  utimesSync(s.file, old, old)
  expect(pruneSessions(h)).toBe(1)
  expect(Session.latest(h, '/p')).toBeUndefined()
})

test('appendUsage writes a usage record that load ignores', () => {
  const h = home()
  const s = Session.create(h, '/w')
  s.append({ role: 'user', content: 'hi' })
  s.appendUsage({ inputTokens: 100, outputTokens: 20, cachedInputTokens: 80, cacheWriteTokens: 5 })
  s.append({ role: 'assistant', content: 'yo' })
  const raw = readFileSync(s.file, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>)
  expect(raw[1]).toMatchObject({ t: 'usage', inputTokens: 100, outputTokens: 20, cachedInputTokens: 80, cacheWriteTokens: 5 })
  expect(s.load()).toEqual([
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'yo' },
  ])
})

test('appendUsage persists the model ref for stats --models', () => {
  const home = mkdtempSync(join(tmpdir(), 'bccli-session-'))
  const session = Session.create(home, '/tmp/proj')
  session.appendUsage({ inputTokens: 10, outputTokens: 2, model: 'bc-cloud/flash' })
  const lines = readFileSync(session.file, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  expect(lines[0]).toEqual({ t: 'usage', inputTokens: 10, outputTokens: 2, model: 'bc-cloud/flash' })
  expect(session.load()).toEqual([])
})

const SUMMARY = 'Summary of the previous conversation:\nthe user built a gateway'
const ACK = 'OK, I will continue from this summary.'
const u = (content: string): ChatMessage => ({ role: 'user', content })
const a = (content: string): ChatMessage => ({ role: 'assistant', content })

// What agent.compact() writes: reset, summary, ack, then the recent turns again.
function compactInto(s: Session, keep: ChatMessage[]) {
  s.reset()
  s.append(u(SUMMARY))
  s.append(a(ACK))
  for (const m of keep) s.append(m)
}

test('loadHistory keeps the whole conversation across a compaction while load() stays compacted', () => {
  const s = Session.create(home(), '/w')
  for (const m of [u('q1'), a('a1'), u('q2'), a('a2'), u('q3'), a('a3')]) s.append(m)
  compactInto(s, [u('q3'), a('a3')])
  s.append(u('q4'))
  s.append(a('a4'))

  expect(s.load().map((m) => m.content)).toEqual([SUMMARY, ACK, 'q3', 'a3', 'q4', 'a4'])
  expect(s.loadHistory().map((m) => m.content)).toEqual(['q1', 'a1', 'q2', 'a2', 'q3', 'a3', 'q4', 'a4'])
})

test('loadHistory survives several compactions without duplicating the recent turns', () => {
  const s = Session.create(home(), '/w')
  for (const m of [u('q1'), a('a1'), u('q2'), a('a2')]) s.append(m)
  compactInto(s, [u('q2'), a('a2')])
  for (const m of [u('q3'), a('a3'), u('q4'), a('a4')]) s.append(m)
  compactInto(s, [u('q4'), a('a4')])
  s.append(u('q5'))

  expect(s.loadHistory().map((m) => m.content)).toEqual(['q1', 'a1', 'q2', 'a2', 'q3', 'a3', 'q4', 'a4', 'q5'])
})

test('loadHistory matches the recent turns by tool call id, so stubbed tool outputs do not duplicate them', () => {
  const s = Session.create(home(), '/w')
  const call = { id: 'c1', type: 'function' as const, function: { name: 'read', arguments: '{}' } }
  s.append(u('look'))
  s.append({ role: 'assistant', content: null, tool_calls: [call] })
  s.append({ role: 'tool', tool_call_id: 'c1', content: 'a very long file body' })
  s.append(a('done'))
  compactInto(s, [
    { role: 'assistant', content: null, tool_calls: [call] },
    { role: 'tool', tool_call_id: 'c1', content: '[output pruned]' },
    a('done'),
  ])
  const history = s.loadHistory()
  expect(history.filter((m) => m.role === 'tool')).toHaveLength(1)
  expect(history.filter((m) => m.role === 'assistant' && m.content === 'done')).toHaveLength(1)
})

test('loadHistory still starts over after a real reset (/clear or rewind), not only after a compaction', () => {
  const s = Session.create(home(), '/w')
  s.append(u('old question'))
  s.append(a('old answer'))
  s.reset()
  s.append(u('fresh'))
  s.append(a('start'))
  expect(s.loadHistory().map((m) => m.content)).toEqual(['fresh', 'start'])
})

test('loadHistory never shows the synthetic summary pair', () => {
  const s = Session.create(home(), '/w')
  s.append(u('q1'))
  s.append(a('a1'))
  compactInto(s, [])
  s.append(u('q2'))
  const texts = s.loadHistory().map((m) => m.content)
  expect(texts).toEqual(['q1', 'a1', 'q2'])
})
