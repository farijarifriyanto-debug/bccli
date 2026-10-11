import { expect, test } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { aggregateSessions, runStatsCommand } from '../src/statsCli'

function makeHome(): string {
  return mkdtempSync(join(tmpdir(), 'bccli-stats-'))
}

function writeSession(home: string, slug: string, file: string, lines: unknown[], ageDays = 0): string {
  const dir = join(home, 'sessions', slug)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, file)
  writeFileSync(path, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`)
  if (ageDays > 0) {
    const t = Date.now() - ageDays * 86400_000
    utimesSync(path, t / 1000, t / 1000)
  }
  return path
}

const msg = (role: string, text: string) => ({ t: 'msg', m: { role, content: text } })

test('aggregateSessions counts sessions, messages and estimates tokens', () => {
  const home = makeHome()
  writeSession(home, 'proj-a', 's1.jsonl', [
    msg('user', 'hello world'),
    msg('assistant', 'hi there'),
    msg('user', 'fix the bug please'),
    msg('assistant', 'done'),
  ])
  writeSession(home, 'proj-a', 's2.jsonl', [msg('user', 'yo')])
  const rows = aggregateSessions(home, { days: 7, now: Date.now() })
  expect(rows).toHaveLength(1)
  expect(rows[0].project).toBe('proj-a')
  expect(rows[0].sessions).toBe(2)
  expect(rows[0].messages).toBe(5)
  expect(rows[0].inputTokens).toBeGreaterThan(0)
  expect(rows[0].outputTokens).toBeGreaterThan(0)
})

test('aggregateSessions respects --days cutoff', () => {
  const home = makeHome()
  writeSession(home, 'old', 'old.jsonl', [msg('user', 'ancient')], 10)
  writeSession(home, 'new', 'new.jsonl', [msg('user', 'fresh')])
  const rows = aggregateSessions(home, { days: 7, now: Date.now() })
  expect(rows.map((r) => r.project)).toEqual(['new'])
})

test('aggregateSessions sums usage records when present', () => {
  const home = makeHome()
  writeSession(home, 'u', 's.jsonl', [
    msg('user', 'x'),
    { t: 'usage', inputTokens: 100, outputTokens: 50 },
    { t: 'usage', inputTokens: 20, outputTokens: 10 },
  ])
  const rows = aggregateSessions(home, { days: 7, now: Date.now() })
  expect(rows[0].usageInputTokens).toBe(120)
  expect(rows[0].usageOutputTokens).toBe(60)
})

test('runStatsCommand prints a table and exits 0', () => {
  const home = makeHome()
  writeSession(home, 'proj', 's.jsonl', [msg('user', 'hello'), msg('assistant', 'world')])
  const lines: string[] = []
  const code = runStatsCommand({ subArgs: [], home, now: Date.now() }, { out: (l) => lines.push(l) })
  expect(code).toBe(0)
  const text = lines.join('\n')
  expect(text).toContain('proj')
  // suite runs in id; assert the session column marker from either language
  expect(text).toMatch(/sesi|session/)
})

test('runStatsCommand parses --days', () => {
  const home = makeHome()
  writeSession(home, 'p', 's.jsonl', [msg('user', 'hi')], 3)
  const lines: string[] = []
  const code = runStatsCommand({ subArgs: ['--days', '1'], home, now: Date.now() }, { out: (l) => lines.push(l) })
  expect(code).toBe(0)
  expect(lines.join('\n')).not.toContain('p')
})

test('runStatsCommand uses pre-parsed days from args.days (real CLI path)', () => {
  // parseCliArgs consumes --days, so subArgs never contains it; args.days must win.
  const home = makeHome()
  writeSession(home, 'p', 's.jsonl', [msg('user', 'hi')], 3)
  const stale: string[] = []
  runStatsCommand({ subArgs: [], home, now: Date.now(), days: 30 }, { out: (l) => stale.push(l) })
  expect(stale.join('\n')).toContain('p')
  const fresh: string[] = []
  runStatsCommand({ subArgs: [], home, now: Date.now(), days: 1 }, { out: (l) => fresh.push(l) })
  expect(fresh.join('\n')).not.toContain('p')
  expect(stale.join('\n')).toContain('30')
})

test('runStatsCommand rejects invalid --days', () => {
  const errs: string[] = []
  const code = runStatsCommand({ subArgs: ['--days', '0'], home: makeHome(), now: Date.now() }, { out: () => {}, err: (l) => errs.push(l) })
  expect(code).toBe(1)
  expect(errs.join('\n')).toMatch(/positive|positif/)
})
