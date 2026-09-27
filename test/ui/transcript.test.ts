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

test('textReplace swaps the streaming answer for the cleaned text', () => {
  let t = applyEvent(empty, { type: 'text', delta: `Halo${'读取'.repeat(50)}` })
  t = applyEvent(t, { type: 'textReplace', text: 'Halo' })
  expect(t.live).toMatchObject([{ kind: 'assistant', text: 'Halo' }])
})

const stream = (t: Transcript, text: string) => [...text].reduce((acc, ch) => applyEvent(acc, { type: 'text', delta: ch }), t)
const printed = (t: Transcript) =>
  t.done
    .filter((e) => e.kind === 'assistant')
    .map((e) => (e.kind === 'assistant' ? e.text : ''))
    .join('\n')

test('a long streamed answer moves finished lines to scrollback so live stays one line tall', () => {
  const lines = Array.from({ length: 60 }, (_, i) => `baris ${i}`)
  const t = stream(empty, `${lines.join('\n')}\nsedang ditulis`)
  expect(t.live).toHaveLength(1)
  expect(t.live[0]).toMatchObject({ kind: 'assistant', text: 'sedang ditulis', cont: true })
  expect(printed(t)).toBe(lines.join('\n'))
  expect(t.done[0]).toMatchObject({ kind: 'assistant', text: 'baris 0' })
  expect(t.done[0]).not.toHaveProperty('cont', true)
})

test('blank lines survive the split and a code block is only printed once closed', () => {
  let t = stream(empty, 'para satu\n\npara dua\n```ts\nconst a = 1\n')
  expect(printed(t)).toBe('para satu\n \npara dua')
  expect(t.live.at(-1)).toMatchObject({ text: '```ts\nconst a = 1\n' })
  t = stream(t, '```\nlanjut')
  expect(printed(t)).toContain('```ts\nconst a = 1\n```')
  expect(t.live.at(-1)).toMatchObject({ text: 'lanjut' })
})

test('text-form tool call markup is held live so textReplace can still remove it', () => {
  let t = stream(empty, 'Saya cek dulu.\n<tool_call>bash\n<arg_key>command</arg_key>\n<arg_value>ls</arg_value>\n</tool_call>\n')
  expect(printed(t)).toBe('Saya cek dulu.')
  t = applyEvent(t, { type: 'textReplace', text: 'Saya cek dulu.' })
  expect(t.live.at(-1)).toMatchObject({ kind: 'assistant', text: '' })
  expect(endTurn(t).done.filter((e) => e.kind === 'assistant')).toHaveLength(1)
})
