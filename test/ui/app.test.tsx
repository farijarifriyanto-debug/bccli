import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { render } from 'ink-testing-library'
import { expect, test } from 'vitest'
import { parseCliArgs } from '../../src/args'
import type { Completion, Provider } from '../../src/provider'
import { createRuntime } from '../../src/setup'
import { readMcpFile } from '../../src/mcp/config'
import { App } from '../../src/ui/App'

const wait = (ms = 60) => new Promise((r) => setTimeout(r, ms))
async function waitFor(check: () => boolean, timeoutMs = 3000) {
  const end = Date.now() + timeoutMs
  while (!check() && Date.now() < end) await wait(20)
}

function scripted(steps: Completion[]): Provider {
  return {
    async chat(req) {
      const next = steps.shift()!
      if (next.text) req.onText?.(next.text)
      return next
    },
    async listModels() {
      return ['glm-5.3-flash', 'kimi-k3']
    },
  }
}

function makeRuntime(steps: Completion[], setupExt?: (cwd: string) => void) {
  const cwd = mkdtempSync(join(tmpdir(), 'bccli-app-'))
  writeFileSync(join(cwd, 'a.txt'), 'old\n')
  setupExt?.(cwd)
  const env = { BCCLI_HOME: mkdtempSync(join(tmpdir(), 'bccli-apph-')), BOTCONNECTOR_API_KEY: 'k', OPENROUTER_API_KEY: 'k' }
  return createRuntime({ cwd, args: parseCliArgs([]), env, provider: scripted(steps), userHome: mkdtempSync(join(tmpdir(), 'bccli-appu-')) })
}

test('full turn: read, edit with permission prompt, final answer', async () => {
  const rt = makeRuntime([
    { text: '', toolCalls: [{ id: '1', name: 'read', arguments: '{"path":"a.txt"}' }] },
    { text: '', toolCalls: [{ id: '2', name: 'edit', arguments: '{"path":"a.txt","old_string":"old","new_string":"new"}' }] },
    { text: 'Sudah diganti.', toolCalls: [] },
  ])
  const { stdin, lastFrame, frames } = render(<App runtime={rt} version="test" />)
  await wait()
  expect(lastFrame()).toContain('BCCLI test')
  stdin.write('ganti old jadi new')
  await wait()
  stdin.write('\r')
  await waitFor(() => frames.some((f) => f.includes('Izinkan edit a.txt?')))
  expect(frames.join('\n')).toContain('Izinkan edit a.txt?')
  expect(frames.join('\n')).toContain('+ new')
  await wait() // let the prompt subscribe to input before answering
  stdin.write('y')
  await waitFor(() => frames.some((f) => f.includes('Sudah diganti.')))
  const all = frames.join('\n')
  expect(all).toContain('⎿ Read  a.txt')
  expect(all).toContain('Sudah diganti.')
})

test('shift+tab cycles the permission mode', async () => {
  const rt = makeRuntime([])
  const { stdin, lastFrame } = render(<App runtime={rt} version="test" />)
  await wait()
  expect(lastFrame()).toContain('⏵ default')
  stdin.write('\u001B[Z')
  await wait()
  expect(lastFrame()).toContain('accept edits')
  expect(rt.agent.permissions.mode).toBe('acceptEdits')
})

test('/cost and unknown commands print notices; /clear resets history', async () => {
  const rt = makeRuntime([])
  rt.agent.messages.push({ role: 'user', content: 'x' })
  const { stdin, frames } = render(<App runtime={rt} version="test" />)
  await wait()
  for (const cmd of ['/cost', '/nope', '/clear']) {
    stdin.write(cmd)
    await wait()
    stdin.write('\r')
    await wait()
  }
  const all = frames.join('\n')
  expect(all).toMatch(/token masuk/)
  expect(all).toContain('Perintah tidak dikenal: /nope')
  expect(rt.agent.messages).toEqual([])
})

test('whitespace-only assistant text before a tool call is not rendered as an empty bubble', async () => {
  const rt = makeRuntime([
    { text: '\n\n', toolCalls: [{ id: '1', name: 'read', arguments: '{"path":"a.txt"}' }] },
    { text: 'ok', toolCalls: [] },
  ])
  const { stdin, frames } = render(<App runtime={rt} version="test" />)
  await wait()
  stdin.write('baca')
  await wait()
  stdin.write('\r')
  await waitFor(() => frames.some((f) => f.includes('● ok')))
  expect(frames.join('\n')).not.toMatch(/● *\n/)
})

test('Esc cancels a running /compact', async () => {
  const rt = makeRuntime([])
  rt.agent.provider = {
    chat: (req) =>
      new Promise((_resolve, reject) => {
        req.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      }),
    async listModels() {
      return []
    },
  }
  const { stdin, frames } = render(<App runtime={rt} version="test" />)
  await wait()
  stdin.write('/compact')
  await wait()
  stdin.write('\r')
  await waitFor(() => frames.some((f) => f.includes('Berpikir')))
  stdin.write('\u001B')
  await waitFor(() => frames.some((f) => f.includes('Gagal meringkas')))
  expect(frames.join('\n')).toContain('Gagal meringkas')
})

test('/model lists every provider and persists the choice as default', async () => {
  const rt = makeRuntime([])
  rt.listModels = async () => [
    { providerId: 'bc-cloud', providerName: 'BotConnector Cloud', models: ['glm-5.3-flash'] },
    { providerId: 'openrouter', providerName: 'OpenRouter', models: ['qwen/qwen3-coder'] },
  ]
  const { stdin, frames } = render(<App runtime={rt} version="test" />)
  await wait()
  stdin.write('/model')
  await wait()
  stdin.write('\r')
  await waitFor(() => frames.some((f) => f.includes('OpenRouter')))
  await wait()
  stdin.write('qwen')
  await wait()
  stdin.write('\r')
  await waitFor(() => rt.modelRef === 'openrouter/qwen/qwen3-coder')
  expect(rt.modelRef).toBe('openrouter/qwen/qwen3-coder')
  expect(JSON.parse(readFileSync(join(rt.home, 'config.json'), 'utf8')).model).toBe('openrouter/qwen/qwen3-coder')
})

test('custom commands expand and run; built-ins win over same-named commands', async () => {
  const rt = makeRuntime([{ text: 'reviewed', toolCalls: [] }], (cwd) => {
    mkdirSync(join(cwd, '.bccli/commands'), { recursive: true })
    writeFileSync(join(cwd, '.bccli/commands/review.md'), '---\ndescription: review\n---\nPlease review $ARGUMENTS')
    writeFileSync(join(cwd, '.bccli/commands/help.md'), 'SHADOW')
  })
  const { stdin, frames } = render(<App runtime={rt} version="test" />)
  await wait()
  stdin.write('/rev')
  await wait()
  expect(frames.at(-1)).toContain('/review')
  stdin.write('iew src/a.ts')
  await wait()
  stdin.write('\r')
  await waitFor(() => frames.some((f) => f.includes('reviewed')))
  expect(rt.agent.messages[0]).toEqual({ role: 'user', content: 'Please review src/a.ts' })
  stdin.write('/help')
  await wait()
  stdin.write('\r')
  await waitFor(() => frames.some((f) => f.includes('Perintah custom')))
  expect(frames.join('\n')).not.toContain('SHADOW')
})

test('/mcp installs a catalog server and its tools reach the agent', async () => {
  const rt = makeRuntime([])
  const { stdin, frames } = render(<App runtime={rt} version="test" />)
  await wait()
  stdin.write('/mcp')
  await wait()
  stdin.write('\r')
  await waitFor(() => frames.some((f) => f.includes('context7')))
  await wait()
  stdin.write('\u001B[B')
  await wait()
  stdin.write('\r')
  await waitFor(() => rt.mcp.states().some((s) => s.name === 'context7'), 20000)
  expect(readMcpFile(join(rt.home, 'mcp.json')).context7).toEqual({ type: 'http', url: 'https://mcp.context7.com/mcp' })
  await rt.mcp.stop()
}, 30000)

test('two permission asks at once are queued, not lost', async () => {
  const rt = makeRuntime([])
  const { stdin, frames } = render(<App runtime={rt} version="test" />)
  await wait()
  const first = rt.agent.askPermission({ tool: 'bash', kind: 'bash', target: 'echo one', sessionRules: ['bash(echo)'] })
  const second = rt.agent.askPermission({ tool: 'bash', kind: 'bash', target: 'echo two', sessionRules: ['bash(echo)'] })
  await waitFor(() => frames.some((f) => f.includes('echo one')))
  await wait()
  stdin.write('y')
  await waitFor(() => frames.some((f) => f.includes('echo two')))
  await wait()
  stdin.write('n')
  expect(await first).toBe('yes')
  expect(await second).toBe('no')
})

test('suggestions show a built-in once; mixed-case command files work; a deleted skill does not crash', async () => {
  const rt = makeRuntime([{ text: 'deployed', toolCalls: [] }], (cwd) => {
    mkdirSync(join(cwd, '.bccli/commands'), { recursive: true })
    writeFileSync(join(cwd, '.bccli/commands/help.md'), 'SHADOW')
    writeFileSync(join(cwd, '.bccli/commands/Deploy.md'), 'Deploy now $ARGUMENTS')
    mkdirSync(join(cwd, '.bccli/skills/gone'), { recursive: true })
    writeFileSync(join(cwd, '.bccli/skills/gone/SKILL.md'), '---\nname: gone\ndescription: g\n---\nG')
  })
  rmSync(join(rt.cwd, '.bccli/skills/gone'), { recursive: true })
  const { stdin, frames } = render(<App runtime={rt} version="test" />)
  await wait()
  stdin.write('/hel')
  await wait()
  expect((frames.at(-1)!.match(/\/help/g) ?? []).length).toBe(1)
  stdin.write('\u007f\u007f\u007f\u007f')
  await wait()
  stdin.write('/deploy prod')
  await wait()
  stdin.write('\r')
  await waitFor(() => frames.some((f) => f.includes('deployed')))
  expect(rt.agent.messages[0]).toEqual({ role: 'user', content: 'Deploy now prod' })
  stdin.write('/gone')
  await wait()
  stdin.write('\r')
  await waitFor(() => frames.some((f) => f.includes('Skill gone tidak bisa dibaca')))
  expect(frames.join('\n')).toContain('Skill gone tidak bisa dibaca')
})

test('answering [s] turns the status bar to allow all', async () => {
  const rt = makeRuntime([
    { text: '', toolCalls: [{ id: '1', name: 'bash', arguments: '{"command":"node -e \\"1\\""}' }] },
    { text: 'selesai', toolCalls: [] },
  ])
  const { stdin, frames, lastFrame } = render(<App runtime={rt} version="test" />)
  await wait()
  stdin.write('jalan')
  await wait()
  stdin.write('\r')
  await waitFor(() => frames.some((f) => f.includes('[s] ya semua')))
  await wait()
  stdin.write('s')
  await waitFor(() => frames.some((f) => f.includes('selesai')))
  expect(lastFrame()).toContain('⏵⏵ allow all')
})

async function slash(stdin: { write(s: string): void }, cmd: string) {
  stdin.write(cmd)
  await wait()
  stdin.write('\r')
}

test('/new, /session and /resume move between sessions', async () => {
  const rt = makeRuntime([
    { text: 'jawab satu', toolCalls: [] },
    { text: 'jawab dua', toolCalls: [] },
  ])
  const { stdin, frames } = render(<App runtime={rt} version="test" />)
  await wait()
  stdin.write('pertanyaan satu')
  await wait()
  stdin.write('\r')
  await waitFor(() => frames.some((f) => f.includes('jawab satu')))
  const first = rt.session.file
  await slash(stdin, '/new ')
  await waitFor(() => rt.session.file !== first)
  expect(rt.agent.messages).toEqual([])
  await slash(stdin, '/session ')
  await waitFor(() => frames.some((f) => f.includes('0 pesan')))
  expect(frames.join('\n')).toContain('0 pesan')
  await slash(stdin, '/resume ')
  await waitFor(() => frames.some((f) => f.includes('pertanyaan satu') && f.includes('Lanjutkan sesi')))
  await wait()
  stdin.write('\r')
  await waitFor(() => rt.session.file === first)
  expect(rt.agent.messages.map((m) => m.content)).toEqual(['pertanyaan satu', 'jawab satu'])
  const resumed = frames.join('\n')
  expect(resumed).toContain('> pertanyaan satu')
  expect(resumed).toContain('● jawab satu')
})


test('/resume replays the complete user/assistant chat instead of only the last three messages', async () => {
  const rt = makeRuntime([])
  const first = rt.session
  const history = [
    { role: 'user' as const, content: 'pesan satu' },
    { role: 'assistant' as const, content: 'jawaban satu' },
    { role: 'user' as const, content: 'pesan dua' },
    { role: 'assistant' as const, content: 'jawaban dua' },
    { role: 'user' as const, content: 'pesan tiga' },
    { role: 'assistant' as const, content: 'jawaban tiga' },
  ]
  for (const message of history) first.append(message)
  rt.newSession()
  const { stdin, frames } = render(<App runtime={rt} version="test" />)
  await wait()
  await slash(stdin, '/resume ')
  await waitFor(() => frames.some((f) => f.includes('Lanjutkan sesi')))
  await wait()
  stdin.write('\r')
  await waitFor(() => rt.session.file === first.file)
  const all = frames.join('\n')
  for (const text of ['pesan satu', 'jawaban satu', 'pesan dua', 'jawaban dua', 'pesan tiga', 'jawaban tiga']) {
    expect(all).toContain(text)
  }
  expect(rt.agent.messages).toHaveLength(6)
})

test('/resume with no other sessions says so', async () => {
  const rt = makeRuntime([])
  const { stdin, frames } = render(<App runtime={rt} version="test" />)
  await wait()
  await slash(stdin, '/resume ')
  await waitFor(() => frames.some((f) => f.includes('Belum ada sesi lain')))
  expect(frames.join('\n')).toContain('Belum ada sesi lain')
})

test('/undo reverts the last turn file edits', async () => {
  const rt = makeRuntime([
    { text: '', toolCalls: [{ id: '1', name: 'read', arguments: '{"path":"a.txt"}' }] },
    { text: '', toolCalls: [{ id: '2', name: 'edit', arguments: '{"path":"a.txt","old_string":"old","new_string":"new"}' }] },
    { text: 'diganti', toolCalls: [] },
  ])
  rt.agent.permissions.mode = 'acceptEdits'
  const { stdin, frames } = render(<App runtime={rt} version="test" />)
  await wait()
  stdin.write('ganti')
  await wait()
  stdin.write('\r')
  await waitFor(() => frames.some((f) => f.includes('diganti')))
  expect(readFileSync(join(rt.cwd, 'a.txt'), 'utf8')).toBe('new\n')
  await slash(stdin, '/undo')
  await waitFor(() => frames.some((f) => f.includes('Dikembalikan: a.txt')))
  expect(readFileSync(join(rt.cwd, 'a.txt'), 'utf8')).toBe('old\n')
  await slash(stdin, '/undo')
  await waitFor(() => frames.some((f) => f.includes('Tidak ada edit file')))
  expect(frames.join('\n')).toContain('Tidak ada edit file')
})

test('/permissions lists rules and revokes a session rule', async () => {
  const rt = makeRuntime([])
  rt.agent.permissions.allowForSession({ tool: 'bash', kind: 'bash', target: 'git status' })
  const { stdin, frames } = render(<App runtime={rt} version="test" />)
  await wait()
  await slash(stdin, '/permissions')
  await waitFor(() => frames.some((f) => f.includes('bash(git status)')))
  await wait()
  stdin.write('\r')
  await waitFor(() => rt.agent.permissions.list().length === 0)
  expect(rt.agent.permissions.list()).toEqual([])
  expect(frames.join('\n')).toContain('Izin bash(git status) dicabut.')
})

test('/memory adds to AGENTS.md; /copy saves the last answer; /status, /diff and /logout answer', async () => {
  const rt = makeRuntime([{ text: 'jawaban terakhir', toolCalls: [] }])
  const { stdin, frames } = render(<App runtime={rt} version="test" />)
  await wait()
  await slash(stdin, '/memory pakai pnpm')
  await waitFor(() => existsSync(join(rt.cwd, 'AGENTS.md')))
  expect(readFileSync(join(rt.cwd, 'AGENTS.md'), 'utf8')).toBe('- pakai pnpm\n')
  stdin.write('halo')
  await wait()
  stdin.write('\r')
  await waitFor(() => frames.some((f) => f.includes('jawaban terakhir')))
  await slash(stdin, '/copy')
  await waitFor(() => existsSync(join(rt.home, 'last-answer.md')))
  expect(readFileSync(join(rt.home, 'last-answer.md'), 'utf8')).toBe('jawaban terakhir')
  await slash(stdin, '/status')
  await waitFor(() => frames.some((f) => f.includes('Mode izin: default')))
  await slash(stdin, '/diff')
  await waitFor(() => frames.some((f) => f.includes('bukan repository git')))
  await slash(stdin, '/logout')
  await waitFor(() => frames.some((f) => f.includes('BOTCONNECTOR_API_KEY masih ada di environment')))
  expect(frames.join('\n')).toContain('BOTCONNECTOR_API_KEY masih ada di environment')
})

test('an error inside a slash command becomes a notice instead of crashing', async () => {
  const rt = makeRuntime([])
  rt.checkpoints.undo = async () => {
    throw new Error('EPERM: file terkunci')
  }
  const { stdin, frames } = render(<App runtime={rt} version="test" />)
  await wait()
  await slash(stdin, '/undo')
  await waitFor(() => frames.some((f) => f.includes('EPERM: file terkunci')))
  expect(frames.join('\n')).toContain('EPERM: file terkunci')
})

test('typing while the agent works queues the message and runs it after the turn; Esc drops the queue', async () => {
  const rt = makeRuntime([])
  const seen: string[] = []
  let gate: Promise<void> | null = null
  let release = () => {}
  const block = () => {
    gate = new Promise<void>((r) => {
      release = () => {
        gate = null
        r()
      }
    })
  }
  rt.agent.provider = {
    async chat(req) {
      seen.push(String(req.messages.at(-1)?.content))
      if (gate) await gate
      return { text: `jawab ${seen.length}`, toolCalls: [] }
    },
    async listModels() {
      return []
    },
  }
  const { stdin, frames, lastFrame } = render(<App runtime={rt} version="test" />)
  const send = async (text: string) => {
    stdin.write(text)
    await wait()
    stdin.write('\r')
  }
  await wait()
  block()
  await send('satu')
  await waitFor(() => (lastFrame() ?? '').includes('Berpikir'))
  stdin.write('dua')
  await wait()
  expect(lastFrame()).toContain('> dua')
  stdin.write('\r')
  await waitFor(() => (lastFrame() ?? '').includes('antri: dua'))
  expect(lastFrame()).toContain('antri: dua')
  expect(seen).toEqual(['satu'])
  release()
  await waitFor(() => frames.some((f) => f.includes('jawab 2')))
  expect(seen).toEqual(['satu', 'dua'])
  expect(lastFrame()).not.toContain('antri:')

  block()
  await send('tiga')
  await waitFor(() => (lastFrame() ?? '').includes('Berpikir'))
  await send('empat')
  await waitFor(() => (lastFrame() ?? '').includes('antri: empat'))
  expect(lastFrame()).toContain('antri: empat')
  stdin.write('\u001B')
  await waitFor(() => frames.some((f) => f.includes('1 pesan antrian dibatalkan')))
  expect(frames.join('\n')).toContain('1 pesan antrian dibatalkan')
  release()
  await wait(300)
  expect(seen).toEqual(['satu', 'dua', 'tiga'])
})

test('thinking is folded to one line; ctrl+t opens and closes it', async () => {
  const rt = makeRuntime([])
  rt.agent.provider = {
    async chat(req) {
      req.onThinking?.('baris satu\nbaris dua')
      req.onText?.('Jawabannya 391.')
      return { text: 'Jawabannya 391.', toolCalls: [], thinking: 'baris satu\nbaris dua' }
    },
    async listModels() {
      return []
    },
  }
  const { stdin, frames, lastFrame } = render(<App runtime={rt} version="test" />)
  await wait()
  stdin.write('17*23?')
  await wait()
  stdin.write('\r')
  await waitFor(() => frames.some((f) => f.includes('Jawabannya 391.')))
  await wait()
  expect(lastFrame()).toContain('✻ Berpikir · 2 baris · ctrl+t buka')
  expect(lastFrame()).not.toContain('baris satu')
  stdin.write('\u0014') // ctrl+t
  await waitFor(() => (lastFrame() ?? '').includes('Thinking ditampilkan'))
  expect(lastFrame()).toContain('baris satu')
  expect(lastFrame()).toContain('✻ Berpikir (ctrl+t tutup)')
  stdin.write('\u0014')
  await waitFor(() => (lastFrame() ?? '').includes('Thinking disembunyikan'))
  expect(lastFrame()).toContain('Thinking disembunyikan')
  expect(rt.agent.messages.at(-1)).toEqual({ role: 'assistant', content: 'Jawabannya 391.' })
})


test('/reasoning direct command persists preference and status bar reflects it', async () => {
  const rt = makeRuntime([])
  const { stdin, frames, lastFrame } = render(<App runtime={rt} version="test" />)
  await wait()
  await slash(stdin, '/reasoning high')
  await waitFor(() => rt.reasoning === 'high')
  expect(rt.reasoning).toBe('high')
  expect(rt.agent.reasoning).toBe('high')
  expect(JSON.parse(readFileSync(join(rt.home, 'config.json'), 'utf8')).reasoning).toBe('high')
  expect(lastFrame()).toContain('reasoning: high')
  expect(frames.join('\n')).toContain('Reasoning: high')
})

test('/reasoning picker uses ListPicker and rejects unsupported levels for the active provider', async () => {
  const rt = makeRuntime([])
  const { stdin, frames } = render(<App runtime={rt} version="test" />)
  await wait()
  await slash(stdin, '/reasoning')
  await waitFor(() => frames.some((f) => f.includes('Auto (model default)') && f.includes('Max')))
  const all = frames.join('\n')
  expect(all).toContain('Reasoning')
  expect(all).toContain('Auto (model default)')
  expect(all).toContain('Off')
  expect(all).toContain('Low')
  expect(all).toContain('Medium')
  expect(all).toContain('High')
  expect(all).toContain('Max')
})


test('new/resume keep model and reasoning preference unchanged', () => {
  const rt = makeRuntime([])
  rt.setReasoning('high')
  const model = rt.modelRef
  const first = rt.session
  first.append({ role: 'user', content: 'saved' })
  rt.newSession()
  expect(rt.reasoning).toBe('high')
  expect(rt.agent.reasoning).toBe('high')
  expect(rt.modelRef).toBe(model)
  rt.resume(first)
  expect(rt.reasoning).toBe('high')
  expect(rt.agent.reasoning).toBe('high')
  expect(rt.modelRef).toBe(model)
  expect(rt.agent.messages).toContainEqual({ role: 'user', content: 'saved' })
})
