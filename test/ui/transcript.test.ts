import { expect, test } from 'vitest'
import { applyEvent, endTurn, type Transcript } from '../../src/ui/transcript'

const empty: Transcript = { done: [], live: [] }

test('finished entries leave the live region as soon as they are complete', () => {
  let t = applyEvent(empty, { type: 'text', delta: 'Saya cek.' })
  t = applyEvent(t, { type: 'toolStart', id: '1', tool: 'read', target: 'a.ts' })
  expect(t.done.map((e) => e.kind)).toEqual(['assistant'])
  expect(t.live.map((e) => e.kind)).toEqual(['tool'])
  t = applyEvent(t, { type: 'toolEnd', id: '1', tool: 'read', output: 'x', isError: false })
  expect(t.live).toEqual([])
  expect(t.done.at(-1)).toMatchObject({ kind: 'tool', done: true, output: 'x' })
})

test('streamed text accumulates in one live entry until the turn ends', () => {
  let t = applyEvent(empty, { type: 'text', delta: 'Hal' })
  t = applyEvent(t, { type: 'text', delta: 'o' })
  expect(t.live).toMatchObject([{ kind: 'assistant', text: 'Halo' }])
  t = endTurn(t)
  expect(t.live).toEqual([])
  expect(t.done).toMatchObject([{ kind: 'assistant', text: 'Halo' }])
})

test('the live region stays small over a long turn', () => {
  let t = empty
  for (let i = 0; i < 40; i++) {
    t = applyEvent(t, { type: 'text', delta: `langkah ${i}` })
    t = applyEvent(t, { type: 'toolStart', id: `${i}`, tool: 'bash', target: 'ls' })
    t = applyEvent(t, { type: 'toolEnd', id: `${i}`, tool: 'bash', output: 'ok', isError: false })
  }
  expect(t.live.length).toBe(0)
  expect(t.done.length).toBe(80)
})

test('parallel tools: a finished tool waits in live until earlier ones finish', () => {
  let t = applyEvent(empty, { type: 'toolStart', id: 'a', tool: 'task', target: 'x' })
  t = applyEvent(t, { type: 'toolStart', id: 'b', tool: 'task', target: 'y' })
  t = applyEvent(t, { type: 'toolEnd', id: 'b', tool: 'task', output: 'ok', isError: false })
  expect(t.live.map((e) => (e.kind === 'tool' ? e.callId : ''))).toEqual(['a', 'b'])
  t = applyEvent(t, { type: 'toolEnd', id: 'a', tool: 'task', output: 'ok', isError: false })
  expect(t.live).toEqual([])
  expect(t.done.map((e) => (e.kind === 'tool' ? e.callId : ''))).toEqual(['a', 'b'])
})

test('subagent tool calls nest under their task entry', () => {
  let t = applyEvent(empty, { type: 'toolStart', id: 't1', tool: 'task', target: '[explore] cari' })
  t = applyEvent(t, { type: 'subagent', parentId: 't1', agent: 'explore', event: { type: 'toolStart', id: 'g', tool: 'grep', target: 'login' } })
  t = applyEvent(t, { type: 'subagent', parentId: 't1', agent: 'explore', event: { type: 'toolEnd', id: 'g', tool: 'grep', output: 'x', isError: false } })
  expect(t.live[0]).toMatchObject({ kind: 'tool', sub: [{ tool: 'grep', target: 'login', done: true }] })
})
