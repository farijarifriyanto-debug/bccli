
import { expect, test } from 'vitest'
import type { ChatMessage } from '../src/provider'
import { estimateMessages, isToolStub, pruneOldToolOutputs, splitKeepRecent, trimToFit } from '../src/tokenBudget'

const user = (content: string): ChatMessage => ({ role: 'user', content })
const assistant = (content: string): ChatMessage => ({ role: 'assistant', content })
const tool = (id: string, content: string): ChatMessage => ({ role: 'tool', tool_call_id: id, content })

test('splitKeepRecent keeps the newest turns that fit the budget, cutting at a user boundary', () => {
  const msgs = [
    user('t0 ' + 'a'.repeat(400)), // ~100 tokens
    assistant('r0'),
    user('t1 ' + 'b'.repeat(400)),
    assistant('r1'),
    user('t2'),
    assistant('r2'),
  ]
  const [old, keep] = splitKeepRecent(msgs, 20)
  expect(keep[0]).toMatchObject({ role: 'user', content: expect.stringContaining('t2') })
  expect(old.at(-1)).toMatchObject({ role: 'assistant', content: 'r1' })
  expect(old.some((m) => m.content === 't0 ' + 'a'.repeat(400))).toBe(true)
})

test('splitKeepRecent with a tiny budget still keeps at least the last user turn', () => {
  const msgs = [user('t0'), assistant('r0'), user('t1 ' + 'x'.repeat(8000)), assistant('r1')]
  const [old, keep] = splitKeepRecent(msgs, 10)
  expect(keep).toHaveLength(2)
  expect(keep[0]).toMatchObject({ role: 'user', content: expect.stringContaining('t1') })
  expect(old).toHaveLength(2)
})

test('splitKeepRecent with an empty history returns empty keep', () => {
  expect(splitKeepRecent([], 100)).toEqual([[], []])
})

test('pruneOldToolOutputs stubs old tool results past 20k tokens, newest ~40k stay intact', () => {
  const msgs: ChatMessage[] = []
  for (let i = 0; i < 8; i++) {
    msgs.push(user(`t${i}`), assistant(''), tool(`c${i}`, 'x'.repeat(36_000)))
  }
  expect(pruneOldToolOutputs(msgs)).toBe(true)
  const tools = msgs.filter((m) => m.role === 'tool') as Array<{ content: string }>
  expect(tools.filter((t) => isToolStub(t.content)).length).toBe(4)
  expect(tools[0].content).toMatch(/Old tool result content cleared/)
  expect(tools.at(-1)?.content).toBe('x'.repeat(36_000))
})

test('pruneOldToolOutputs is a no-op under the prune minimum (keeps the prompt cache)', () => {
  const msgs: ChatMessage[] = [user('t'), assistant(''), tool('c1', 'x'.repeat(10_000))]
  const before = JSON.stringify(msgs)
  expect(pruneOldToolOutputs(msgs)).toBe(false)
  expect(JSON.stringify(msgs)).toBe(before)
})

test('estimateMessages bounds base64 image_url token cost and splitKeepRecent/trimToFit do not split mid-turn on image attachment messages', () => {
  const bigBase64 = `data:image/png;base64,${'A'.repeat(400_000)}`
  const imgMsg: ChatMessage = {
    role: 'user',
    content: [
      { type: 'text', text: 'Image read from screenshot.png.' },
      { type: 'image_url', image_url: { url: bigBase64 } },
    ],
  }
  const msgs: ChatMessage[] = [
    user(`turn 1 old prompt ${'x'.repeat(800)}`),
    assistant('turn 1 reply'),
    user('turn 2 inspect screenshot'),
    { role: 'assistant', content: null, tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'read', arguments: '{"path":"screenshot.png"}' } }] },
    tool('tc1', 'Read image screenshot.png'),
    imgMsg,
    assistant('The screenshot shows a button.'),
  ]
  expect(estimateMessages([imgMsg])).toBeLessThan(5_000)
  const [, keep] = splitKeepRecent(msgs, 50)
  expect(keep[0]).toMatchObject({ role: 'user', content: 'turn 2 inspect screenshot' })
  const trimmed = trimToFit(msgs, 50)
  expect(trimmed[0]).toMatchObject({ role: 'user', content: 'turn 2 inspect screenshot' })
})
