import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { osc52 } from '../src/slash/copy'
import { gitDiff } from '../src/slash/diff'
import { doctorText } from '../src/slash/doctor'
import { exportMarkdown } from '../src/slash/export'
import { agentsText, sessionText, skillsText, statusText } from '../src/slash/info'

test('statusText summarises version, model, mode, MCP and context use', () => {
  const text = statusText({
    version: '0.4.0',
    modelRef: 'bc-cloud/glm',
    providerLabel: 'BotConnector Cloud',
    mode: 'default',
    cwd: '/w',
    mcp: [
      { name: 'context7', status: 'ready', tools: 2 },
      { name: 'git', status: 'error', error: 'spawn uvx ENOENT', tools: 0 },
    ],
    usage: { inputTokens: 12000, outputTokens: 800 },
    lastInputTokens: 32000,
  })
  expect(text).toContain('BCCLI 0.4.0')
  expect(text).toContain('bc-cloud/glm (BotConnector Cloud)')
  expect(text).toContain('MCP: 1 aktif, 1 error')
  expect(text).toContain('Konteks: ±25%')
})

test('agents, skills and session texts', () => {
  expect(agentsText([{ name: 'explore', description: 'baca saja', tools: ['read', 'grep'] }, { name: 'general', description: 'semua' }])).toContain(
    'general — semua · alat: semua · model: ikut utama',
  )
  expect(skillsText([{ name: 'tdd', description: 'test dulu', dir: '/s/tdd' }], [{ name: 'review', description: 'review diff' }])).toContain('/review — review diff')
  expect(sessionText({ file: '/h/s.jsonl', started: new Date('2026-09-27T01:02:00Z'), messages: 6, usage: { inputTokens: 100, outputTokens: 20 }, modelRef: 'm' })).toContain('6 pesan')
})

test('exportMarkdown keeps user/assistant text and summarises tool calls', () => {
  const md = exportMarkdown(
    [
      { role: 'user', content: 'perbaiki bug' },
      { role: 'assistant', content: null, tool_calls: [{ id: '1', type: 'function', function: { name: 'read', arguments: '{"path":"a.ts"}' } }] },
      { role: 'tool', tool_call_id: '1', content: 'isi file' },
      { role: 'assistant', content: 'Sudah.' },
    ],
    'Sesi BCCLI',
  )
  expect(md).toContain('## User\n\nperbaiki bug')
  expect(md).toContain('⎿ read {"path":"a.ts"}')
  expect(md).toContain('## BCCLI\n\nSudah.')
  expect(md).not.toContain('isi file')
})

test('gitDiff: outside a repo is a clear message; inside shows stat, diff and new files', async () => {
  expect(await gitDiff(mkdtempSync(join(tmpdir(), 'bccli-nogit-')))).toMatch(/bukan repository git/)
  const repo = mkdtempSync(join(tmpdir(), 'bccli-git-'))
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: repo })
  git('init', '-q')
  writeFileSync(join(repo, 'a.txt'), 'x\n')
  git('add', 'a.txt')
  git('commit', '-q', '-m', 'a')
  expect(await gitDiff(repo)).toMatch(/Tidak ada perubahan/)
  writeFileSync(join(repo, 'a.txt'), 'y\n')
  writeFileSync(join(repo, 'b.txt'), 'z\n')
  const out = await gitDiff(repo)
  expect(out).toContain('a.txt')
  expect(out).toContain('+y')
  expect(out).toContain('File baru (belum di-track): b.txt')
})

test('osc52 encodes base64 and wraps for tmux', () => {
  expect(osc52('hi', false)).toBe('\u001B]52;c;aGk=\u0007')
  expect(osc52('hi', true)).toBe('\u001BPtmux;\u001B\u001B]52;c;aGk=\u0007\u001B\\')
})

test('doctorText reports node, keys, connection, MCP and tools', async () => {
  const text = await doctorText(
    {
      providers: [
        { id: 'bc-cloud', name: 'BotConnector Cloud', ready: true },
        { id: 'groq', name: 'Groq', ready: false },
      ],
      mcp: [{ name: 'git', status: 'error', error: 'spawn uvx ENOENT' }],
      activeProvider: 'BotConnector Cloud',
    },
    { which: (c) => c !== 'uvx', nodeVersion: 'v24.1.0', listModels: async () => [1, 2] },
  )
  expect(text).toContain('✓ Node v24.1.0')
  expect(text).toContain('○ Groq')
  expect(text).toContain('✓ Koneksi BotConnector Cloud (2 model)')
  expect(text).toContain('✗ MCP git: spawn uvx ENOENT')
  expect(text).toContain('✗ uvx')
  const down = await doctorText({ providers: [], mcp: [], activeProvider: 'X' }, { which: () => true, nodeVersion: 'v20.0.0', listModels: async () => Promise.reject(new Error('401')) })
  expect(down).toContain('✗ Node v20.0.0 (butuh ≥ 22)')
  expect(down).toContain('✗ Koneksi X: 401')
})

test('gitDiff includes staged changes and works before the first commit', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'bccli-git3-'))
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: repo })
  git('init', '-q')
  writeFileSync(join(repo, 'first.txt'), 'pertama\n')
  git('add', 'first.txt')
  expect(await gitDiff(repo)).toContain('+pertama')
  git('commit', '-q', '-m', 'a')
  writeFileSync(join(repo, 'first.txt'), 'kedua\n')
  git('add', 'first.txt')
  expect(await gitDiff(repo)).toContain('+kedua')
})
