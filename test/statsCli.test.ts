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

const usageRec = (i: number, o: number, cr = 0, cw = 0) => ({ t: 'usage', inputTokens: i, outputTokens: o, cachedInputTokens: cr, cacheWriteTokens: cw })
const toolMsg = (...names: string[]) => ({
  t: 'msg',
  m: { role: 'assistant', content: null, tool_calls: names.map((n, k) => ({ id: `c${k}_${n}`, type: 'function', function: { name: n, arguments: '{}' } })) },
})

test('sessions with recorded usage use it instead of estimates, without double counting cache', () => {
  const home = makeHome()
  writeSession(home, 'rec', 's.jsonl', [
    msg('user', 'x'.repeat(400)),
    usageRec(100, 50, 80, 5),
    usageRec(20, 10),
  ])
  const rows = aggregateSessions(home, { days: 7, now: Date.now() })
  expect(rows[0].inputTokens).toBe(0)
  expect(rows[0].outputTokens).toBe(0)
  expect(rows[0].usageInputTokens).toBe(120)
  expect(rows[0].usageOutputTokens).toBe(60)
  expect(rows[0].cachedInputTokens).toBe(80)
  expect(rows[0].cacheWriteTokens).toBe(5)
  // prompt_tokens already includes cache reads, so the per-session total is input + output only;
  // cache is reported on its own lines and would otherwise be counted twice.
  expect(rows[0].sessionTotals).toEqual([180])
})

test('sessions without usage keep estimate basis and mixed rows sum both', () => {
  const home = makeHome()
  writeSession(home, 'mix', 'a.jsonl', [msg('user', 'hello world')])
  writeSession(home, 'mix', 'b.jsonl', [usageRec(500, 100)])
  const rows = aggregateSessions(home, { days: 7, now: Date.now() })
  expect(rows[0].sessions).toBe(2)
  expect(rows[0].inputTokens).toBeGreaterThan(0)
  expect(rows[0].usageInputTokens).toBe(500)
})

test('aggregateSessions counts tool calls by name from assistant tool_calls', () => {
  const home = makeHome()
  writeSession(home, 'tools', 's.jsonl', [
    toolMsg('read', 'read'),
    msg('assistant', 'done'),
    toolMsg('bash'),
  ])
  const rows = aggregateSessions(home, { days: 7, now: Date.now() })
  expect(rows[0].toolCalls).toEqual({ read: 2, bash: 1 })
})

test('runStatsCommand prints overview, tokens and tool boxes like opencode', () => {
  const home = makeHome()
  writeSession(home, 'proj', 's.jsonl', [
    usageRec(1_500, 2_000, 627_400_000, 1_500_000),
    toolMsg('bash', 'read', 'read'),
    msg('assistant', 'ok'),
  ])
  const lines: string[] = []
  const code = runStatsCommand({ subArgs: [], home, now: Date.now() }, { out: (l) => lines.push(l) })
  expect(code).toBe(0)
  const text = lines.join('\n')
  for (const label of ['OVERVIEW', 'TOKENS', 'TOOL USAGE', 'Sessions', 'Messages', 'Days', 'Input', 'Output', 'Cache Read', 'Cache Write', 'Avg Tokens/Session', 'Median Tokens/Session']) {
    expect(text).toContain(label)
  }
  expect(text).toContain('1.5K')
  expect(text).toContain('627.4M')
  expect(text).toContain('\u2588')
  expect(text).toMatch(/read\s+\S*\u2588.*\(\s*66\.7%\)/)
  expect(text).toContain('proj')
})

test('runStatsCommand skips the tool box when a window has no tool calls', () => {
  const home = makeHome()
  writeSession(home, 'quiet', 's.jsonl', [msg('user', 'hi')])
  const lines: string[] = []
  runStatsCommand({ subArgs: [], home, now: Date.now() }, { out: (l) => lines.push(l) })
  expect(lines.join('\n')).not.toContain('TOOL USAGE')
})

test('long tool names are truncated with .. so the box never breaks', () => {
  const home = makeHome()
  writeSession(home, 'trunc', 's.jsonl', [toolMsg('a_very_long_tool_name_over_sixteen')])
  const lines: string[] = []
  runStatsCommand({ subArgs: [], home, now: Date.now() }, { out: (l) => lines.push(l) })
  const text = lines.join('\n')
  expect(text).toContain('a_very_long_tool..')
  expect(text).not.toContain('a_very_long_tool_name_over_sixteen')
  for (const line of lines.filter((l) => l.includes('\u2588'))) {
    expect(line.startsWith('\u2502') && line.endsWith('\u2502')).toBe(true)
  }
})

test('models flag shows MODEL USAGE box aggregated per model', () => {
  const home = makeHome()
  writeSession(home, 'm', 'a.jsonl', [
    { t: 'usage', inputTokens: 100, outputTokens: 10, model: 'bc-cloud/flash' },
    { t: 'usage', inputTokens: 50, outputTokens: 5, model: 'bc-cloud/flash' },
    { t: 'usage', inputTokens: 900, outputTokens: 90, model: 'gmi/deep' },
  ])
  const lines: string[] = []
  runStatsCommand({ subArgs: ['--models'], home, now: Date.now() }, { out: (l) => lines.push(l) })
  const text = lines.join('\n')
  expect(text).toContain('MODEL USAGE')
  expect(text).toContain('bc-cloud/flash')
  expect(text).toContain('gmi/deep')
  const flashIdx = text.indexOf('bc-cloud/flash')
  const deepIdx = text.indexOf('gmi/deep')
  expect(deepIdx).toBeGreaterThanOrEqual(0)
  expect(flashIdx).toBeGreaterThan(deepIdx)
})

test('models N shows only top N models by tokens', () => {
  const home = makeHome()
  writeSession(home, 'm', 'a.jsonl', [
    { t: 'usage', inputTokens: 10, outputTokens: 1, model: 'small' },
    { t: 'usage', inputTokens: 5000, outputTokens: 100, model: 'big' },
    { t: 'usage', inputTokens: 500, outputTokens: 10, model: 'mid' },
  ])
  const lines: string[] = []
  runStatsCommand({ subArgs: ['--models', '2'], home, now: Date.now() }, { out: (l) => lines.push(l) })
  const text = lines.join('\n')
  expect(text).toContain('MODEL USAGE')
  expect(text).toContain('big')
  expect(text).toContain('mid')
  expect(text).not.toContain('small')
})

test('tools N limits the number of tool rows', () => {
  const home = makeHome()
  writeSession(home, 't', 's.jsonl', [toolMsg('alpha', 'beta', 'gamma')])
  const lines: string[] = []
  runStatsCommand({ subArgs: ['--tools', '2'], home, now: Date.now() }, { out: (l) => lines.push(l) })
  const text = lines.join('\n')
  expect(text).toContain('alpha')
  expect(text).toContain('beta')
  expect(text).not.toContain('gamma')
})

test('project filter restricts rows to matching project slug', () => {
  const home = makeHome()
  writeSession(home, 'alpha-proj', 's.jsonl', [msg('user', 'x')])
  writeSession(home, 'beta-proj', 's.jsonl', [msg('user', 'y')])
  const lines: string[] = []
  runStatsCommand({ subArgs: ['--project', 'alpha'], home, now: Date.now() }, { out: (l) => lines.push(l) })
  const text = lines.join('\n')
  expect(text).toContain('alpha-proj')
  expect(text).not.toContain('beta-proj')
})

test('empty project filter resolves to the current cwd slug', () => {
  const home = makeHome()
  writeSession(home, 'C-cur-proj', 's.jsonl', [msg('user', 'x')])
  writeSession(home, 'other-proj', 's.jsonl', [msg('user', 'y')])
  const lines: string[] = []
  runStatsCommand({ subArgs: ['--project', ''], home, cwd: 'C:\\cur\\proj', now: Date.now() }, { out: (l) => lines.push(l) })
  const text = lines.join('\n')
  expect(text).toContain('C-cur-proj')
  expect(text).not.toContain('other-proj')
})
