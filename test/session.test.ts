import { appendFileSync, mkdtempSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { pruneSessions, Session } from '../src/session'

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

test('load drops a trailing assistant tool call without results (crash mid-tool)', () => {
  const s = Session.create(home(), '/w')
  s.append({ role: 'user', content: 'go' })
  s.append({ role: 'assistant', content: null, tool_calls: [{ id: 'a', type: 'function', function: { name: 'bash', arguments: '{}' } }] })
  expect(s.load()).toEqual([{ role: 'user', content: 'go' }])
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
