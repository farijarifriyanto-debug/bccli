import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { render } from 'ink-testing-library'
import { expect, test } from 'vitest'
import { parseCliArgs } from '../../src/args'
import type { Completion, Provider } from '../../src/provider'
import { setLanguage } from '../../src/i18n'
import { createRuntime } from '../../src/setup'
import { readMcpFile } from '../../src/mcp/config'
import { App } from '../../src/ui/App'

const wait = (ms = 60) => new Promise((r) => setTimeout(r, ms))
// Batas 3 dtk terlalu ketat saat runner lambat (Windows CI): waitFor dulu pulang diam-diam,
// lalu kegagalan muncul sebagai assertion isi berkas yang menyesatkan. Naikkan batas dan gagal dengan pesan jelas.
async function waitFor(check: () => boolean, timeoutMs = 6000) {
  const end = Date.now() + timeoutMs
  while (!check() && Date.now() < end) await wait(20)
  if (!check()) throw new Error(`waitFor tidak terpenuhi dalam ${timeoutMs} ms: ${check.toString().slice(0, 100)}`)
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

test('a new BCCLI release is visible inside the Ink UI without blocking input', async () => {
  const rt = makeRuntime([])
  const message = 'bccli versi baru tersedia: 0.4.0-beta.53. Jalankan: bccli update'
  const { lastFrame } = render(<App runtime={rt} version="0.4.0-beta.52" updateMessage={message} />)
  await wait()
  expect(lastFrame()).toContain('BCCLI 0.4.0-beta.52')
  expect(lastFrame()).toContain(message)
  expect(lastFrame()).toContain('bccli update')
  expect(lastFrame()).toContain('>')
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

test('Esc cancels a never-settling mock provider and the next prompt still runs', async () => {
  const rt = makeRuntime([])
  let requests = 0
  rt.agent.provider = {
    async chat(req) {
      requests++
      if (requests === 1) return new Promise<Completion>(() => {})
      req.onText?.('NEXT_TURN_OK')
      return { text: 'NEXT_TURN_OK', toolCalls: [] }
    },
    async listModels() { return [] },
  }
  const { stdin, lastFrame, frames, unmount } = render(<App runtime={rt} version="test" />)
  await wait()
  stdin.write('mock long request')
  await wait()
  stdin.write('\r')
  await waitFor(() => requests === 1 && (lastFrame() ?? '').includes('esc batal'))
  expect((lastFrame() ?? '')).toContain('esc batal')
  stdin.write('\u001B')
  await waitFor(() => frames.some((frame) => frame.includes('Dibatalkan.')))
  expect(frames.some((frame) => frame.includes('Dibatalkan.'))).toBe(true)
  stdin.write('next request')
  await wait()
  stdin.write('\r')
  await waitFor(() => frames.some((frame) => frame.includes('NEXT_TURN_OK')))
  expect(requests).toBe(2)
  unmount()
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
  // Jawaban model dirender lewat <Static> (tidak masuk frame), jadi tunggu efek yang teramati di state.
  await waitFor(() => rt.agent.messages.some((m) => typeof m.content === 'string' && m.content.includes('selesai')))
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
  // Teks percakapan dirender lewat <Static>, yang tidak muncul di frame ink-testing-library;
  // jadi tunggu efek yang bisa diamati: provider dipanggil untuk pesan kedua.
  await waitFor(() => seen.length === 2)
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

test('Thinking uses one reversible panel; repeated ctrl+t does not append duplicate scrollback', async () => {
  const rt = makeRuntime([])
  rt.agent.provider = {
    async chat(req) {
      req.onThinking?.('baris satu\nbaris dua')
      req.onText?.('Jawabannya 391.')
      return { text: 'Jawabannya 391.', toolCalls: [], thinking: 'baris satu\nbaris dua' }
    },
    async listModels() { return [] },
  }
  const { stdin, frames, lastFrame } = render(<App runtime={rt} version="test" />)
  await wait()
  stdin.write('17*23?')
  await wait()
  stdin.write('\r')
  await waitFor(() => frames.some((f) => f.includes('Jawabannya 391.')))
  await waitFor(() => (lastFrame() ?? '').includes('ctrl+t'))
  expect(lastFrame()).not.toContain('klik untuk buka/tutup')
  expect(lastFrame()).not.toContain('baris satu')
  for (let n = 0; n < 3; n++) {
    stdin.write('\u0014')
    await waitFor(() => (lastFrame() ?? '').includes('baris satu'))
    expect((lastFrame() ?? '').split('baris satu').length - 1).toBe(1)
    expect(JSON.parse(readFileSync(join(rt.home, 'config.json'), 'utf8')).thinkingVisible).toBe(true)
    stdin.write('\u0014')
    await waitFor(() => !(lastFrame() ?? '').includes('baris satu'))
    expect(JSON.parse(readFileSync(join(rt.home, 'config.json'), 'utf8')).thinkingVisible).toBe(false)
    expect(lastFrame()).not.toContain('Thinking shown')
    expect(lastFrame()).not.toContain('Thinking hidden')
  }
  expect(rt.agent.messages.at(-1)).toEqual({ role: 'assistant', content: 'Jawabannya 391.' })
  await slash(stdin, '/clear')
  await waitFor(() => rt.agent.messages.length === 0)
  expect(lastFrame()).not.toContain('baris satu')
  expect(lastFrame()).not.toContain('klik untuk buka/tutup')
})


test('mouse reporting stays off by default so terminal drag-to-copy and touchpad scroll keep working', async () => {
  const rt = makeRuntime([])
  expect(rt.config.thinkingClickCollapse).toBe(false)
  let release: (() => void) | undefined
  rt.agent.provider = {
    async chat() {
      await new Promise<void>((resolve) => { release = resolve })
      return { text: 'MOCK_OK', toolCalls: [] }
    },
    async listModels() { return [] },
  }
  const { stdin, stdout, frames, lastFrame, unmount } = render(<App runtime={rt} version="test" />)
  Object.assign(stdout, { isTTY: true })
  await wait()
  stdin.write('no mouse please')
  await wait()
  stdin.write('\r')
  await waitFor(() => (lastFrame() ?? '').includes('ctrl+t'))
  await wait(50)
  expect(frames.join('')).not.toContain('\x1b[?1000h')
  expect(lastFrame()).not.toContain('klik untuk buka/tutup')
  release?.()
  await waitFor(() => rt.agent.messages.some((m) => typeof m.content === 'string' && m.content.includes('MOCK_OK')))
  unmount()
}, 20000)

test('SGR mouse click toggles live Thinking without inserting control bytes into the prompt', async () => {
  const rt = makeRuntime([])
  rt.config.thinkingClickCollapse = true
  let release: (() => void) | undefined
  rt.agent.provider = {
    async chat() {
      await new Promise<void>((resolve) => { release = resolve })
      return { text: 'MOCK_OK', toolCalls: [] }
    },
    async listModels() { return [] },
  }
  const { stdin, stdout, lastFrame, unmount } = render(<App runtime={rt} version="test" />)
  Object.assign(stdout, { isTTY: true })
  await wait()
  stdin.write('mouse canary')
  await wait()
  stdin.write('\r')
  await waitFor(() => (lastFrame() ?? '').includes('ctrl+t'))
  let clicked = false
  for (let y = 1; y <= 50; y++) {
    stdin.write('\x1b[<0;10;' + y + 'M')
    await wait(5)
    stdin.write('\x1b[50;1R')
    await wait(12)
    if ((lastFrame() ?? '').includes('Model:')) {
      clicked = true
      break
    }
  }
  expect(clicked).toBe(true)
  expect(lastFrame()).toContain('Model:')
  // The reporter must survive the frame reflow when the inspector expands.
  let closed = false
  for (let y = 1; y <= 50; y++) {
    stdin.write('\x1b[<0;10;' + y + 'M\x1b[50;1R')
    await wait(12)
    if (!(lastFrame() ?? '').includes('Model:')) {
      closed = true
      break
    }
  }
  expect(closed).toBe(true)
  expect(lastFrame()).not.toContain('Model:')
  release?.()
  await waitFor(() => rt.agent.messages.some((m) => typeof m.content === 'string' && m.content.includes('MOCK_OK')))
  expect(rt.agent.messages.filter((message) => message.role === 'user')).toHaveLength(1)
  unmount()
}, 20000)

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

test('in English the help, permission prompt and notices are English', async () => {
  setLanguage('en')
  try {
    const rt = makeRuntime([
      { text: '', toolCalls: [{ id: '1', name: 'read', arguments: '{"path":"a.txt"}' }] },
      { text: '', toolCalls: [{ id: '2', name: 'edit', arguments: '{"path":"a.txt","old_string":"old","new_string":"new"}' }] },
      { text: 'Done.', toolCalls: [] },
    ])
    const { stdin, lastFrame, frames } = render(<App runtime={rt} version="test" />)
    await wait()
    expect(lastFrame()).toContain('shift+tab switch mode')
    stdin.write('/help')
    await wait()
    stdin.write('\r')
    await waitFor(() => frames.some((f) => f.includes('list of commands and shortcuts')))
    const help = frames.join('\n')
    expect(help).toContain('undo the file edits of the last turn')
    expect(help).toContain('ctrl+t     show/hide the model’s thinking')
    expect(help).not.toContain('batalkan edit file')
    stdin.write('/nope')
    await wait()
    stdin.write('\r')
    await waitFor(() => frames.some((f) => f.includes('Unknown command: /nope. Type /help.')))
    stdin.write('change old to new')
    await wait()
    stdin.write('\r')
    await waitFor(() => frames.some((f) => f.includes('Allow edit a.txt?')))
    expect(frames.join('\n')).toContain('[y] yes')
    expect(frames.join('\n')).toContain('[n] no')
    await wait()
    stdin.write('y')
    await waitFor(() => frames.some((f) => f.includes('Done.')))
    expect(frames.join('\n')).not.toContain('Izinkan')
  } finally {
    setLanguage('id')
  }
})

test('/language shows, switches and saves the interface language', async () => {
  try {
    const rt = makeRuntime([])
    const { stdin, lastFrame, frames } = render(<App runtime={rt} version="test" />)
    await wait()
    const run = async (command: string) => {
      stdin.write(command)
      await wait()
      stdin.write('\r')
      await wait(150)
    }
    await run('/language')
    expect(lastFrame()).toContain('Bahasa: id.')
    await run('/language xx')
    expect(frames.join('\n')).toContain('Bahasa "xx" tidak dikenal. Pakai en atau id.')
    await run('/language en')
    await waitFor(() => frames.some((f) => f.includes('Language set to en (saved as default).')))
    expect(JSON.parse(readFileSync(join(rt.env.BCCLI_HOME as string, 'config.json'), 'utf8')).language).toBe('en')
    await run('/cost')
    expect(lastFrame()).toMatch(/tokens in · .* tokens out/)
    await run('/language id')
    await waitFor(() => frames.some((f) => f.includes('Bahasa diatur ke id (tersimpan sebagai default).')))
    expect(JSON.parse(readFileSync(join(rt.env.BCCLI_HOME as string, 'config.json'), 'utf8')).language).toBe('id')
  } finally {
    setLanguage('id')
  }
})

test('a conversation loaded at start (-c / -r) is shown on screen, not only the header', async () => {
  const rt = makeRuntime([])
  rt.session.append({ role: 'user', content: 'pertanyaan lama' })
  rt.session.append({ role: 'assistant', content: 'jawaban lama' })
  rt.agent.load(rt.session.load())
  const { frames } = render(<App runtime={rt} version="test" />)
  await waitFor(() => frames.join('\n').includes('jawaban lama'))
  const all = frames.join('\n')
  expect(all).toContain('pertanyaan lama')
  expect(all).toContain('jawaban lama')
})

test('!command and #memory prompt shortcuts execute locally without calling the LLM provider', async () => {
  const rt = makeRuntime([])
  const { stdin, frames } = render(<App runtime={rt} version="test" />)
  await wait()
  stdin.write('#always use strict types')
  await wait()
  stdin.write('\r')
  await waitFor(() => existsSync(join(rt.cwd, 'AGENTS.md')))
  expect(readFileSync(join(rt.cwd, 'AGENTS.md'), 'utf8')).toContain('always use strict types')

  stdin.write('!node -e "console.log(12345 + 54321)"')
  await wait()
  stdin.write('\r')
  await waitFor(() => frames.join('\n').includes('66666'), 10000)
  expect(rt.agent.messages.some((m) => typeof m.content === 'string' && m.content.includes('66666'))).toBe(true)
}, 15000)

test('live Thinking spinner and expanded inspector show the currently running tool activity', async () => {
  const rt = makeRuntime([
    { text: '', toolCalls: [{ id: '1', name: 'bash', arguments: '{"command":"node -e \\"setTimeout(()=>{}, 800)\\""}' }] },
    { text: 'TOOL_FINISHED', toolCalls: [] },
  ])
  rt.agent.permissions.mode = 'allowAll'
  const { stdin, lastFrame, frames, unmount } = render(<App runtime={rt} version="test" />)
  await wait()
  await slash(stdin, '/config thinkingVisible true')
  await slash(stdin, '/config thinkingClickCollapse true')
  expect(rt.config.thinkingVisible).toBe(true)
  expect(rt.config.thinkingClickCollapse).toBe(true)
  stdin.write('jalankan bash')
  await wait()
  stdin.write('\r')
  await waitFor(() => (lastFrame() ?? '').includes('Berpikir · Bash'))
  expect(lastFrame()).toContain('Berpikir · Bash')
  expect(lastFrame()).toContain('klik untuk buka/tutup')
  expect(lastFrame()).toContain('▶ Bash')
  await waitFor(() => frames.some((f) => f.includes('TOOL_FINISHED')), 6000)
  unmount()
}, 15000)

test('ctrl+o expands and collapses tool output in-place without appending a duplicate block', async () => {
  const linesCmd = 'node -e "for(let i=0;i<12;i++)console.log(\'OUTLINE_\'+i)"'
  const rt = makeRuntime([
    { text: '', toolCalls: [{ id: '1', name: 'bash', arguments: JSON.stringify({ command: linesCmd }) }] },
    { text: 'SELESAI_BASH', toolCalls: [] },
  ])
  rt.agent.permissions.mode = 'allowAll'
  const { stdin, lastFrame, frames, unmount } = render(<App runtime={rt} version="test" />)
  await wait()
  stdin.write('tes ctrl+o')
  await wait()
  stdin.write('\r')
  await waitFor(() => frames.some((f) => f.includes('SELESAI_BASH')))
  expect(lastFrame()).toContain('OUTLINE_3')
  expect(lastFrame()).not.toContain('OUTLINE_10')
  expect(lastFrame()).toContain('baris lagi (ctrl+o)')

  // First ctrl+o expands in-place without adding a second tool block
  stdin.write('\u000f')
  await waitFor(() => (lastFrame() ?? '').includes('OUTLINE_10'))
  expect(lastFrame()).toContain('OUTLINE_10')
  expect(lastFrame()).toContain('(ctrl+o untuk menutup)')
  expect(((lastFrame() ?? '').match(/⎿\s+bash/gi) ?? []).length).toBe(1)

  // Second ctrl+o collapses back to 5 preview lines
  stdin.write('\u000f')
  await waitFor(() => !(lastFrame() ?? '').includes('OUTLINE_10'))
  expect(lastFrame()).not.toContain('OUTLINE_10')
  expect(lastFrame()).toContain('baris lagi (ctrl+o)')
  unmount()
})

test('Thinking is rendered at its chronological position above tool calls and assistant answer, not at the bottom', async () => {
  const rt = makeRuntime([])
  let step = 0
  rt.agent.provider = {
    async chat(req) {
      step++
      if (step === 1) {
        req.onThinking?.('PIKIRAN_ATAS_SEBELUM_TOOL')
        return {
          text: '',
          thinking: 'PIKIRAN_ATAS_SEBELUM_TOOL',
          toolCalls: [{ id: '1', name: 'read', arguments: '{"path":"a.txt"}' }],
        }
      }
      req.onText?.('JAWABAN_AKHIR_BAWAH')
      return { text: 'JAWABAN_AKHIR_BAWAH', toolCalls: [] }
    },
    async listModels() {
      return []
    },
  }
  const { stdin, lastFrame, frames, unmount } = render(<App runtime={rt} version="test" />)
  await wait()
  stdin.write('cek urutan thinking')
  await wait()
  stdin.write('\r')
  await waitFor(() => frames.some((f) => f.includes('JAWABAN_AKHIR_BAWAH')))
  // Collapsed header is already above the tool call and final answer
  const collapsedFrame = lastFrame() ?? ''
  expect(collapsedFrame.indexOf('✻ Berpikir')).toBeGreaterThan(-1)
  expect(collapsedFrame.indexOf('✻ Berpikir')).toBeLessThan(collapsedFrame.indexOf('⎿ Read  a.txt'))
  expect(collapsedFrame.indexOf('⎿ Read  a.txt')).toBeLessThan(collapsedFrame.indexOf('● JAWABAN_AKHIR_BAWAH'))

  // Expanding with ctrl+t reveals the thinking text at the top (before tool and answer), never at the bottom
  stdin.write('\u0014')
  await waitFor(() => (lastFrame() ?? '').includes('PIKIRAN_ATAS_SEBELUM_TOOL'))
  const expandedFrame = lastFrame() ?? ''
  expect(expandedFrame.indexOf('PIKIRAN_ATAS_SEBELUM_TOOL')).toBeLessThan(expandedFrame.indexOf('⎿ Read  a.txt'))
  expect(expandedFrame.indexOf('PIKIRAN_ATAS_SEBELUM_TOOL')).toBeLessThan(expandedFrame.indexOf('● JAWABAN_AKHIR_BAWAH'))
  unmount()
})

test('after a turn with Thinking finishes, clicking Thinking (when opted in) still toggles it and 2-finger touchpad scroll immediately releases ?1000l', async () => {
  const rt = makeRuntime([])
  rt.config.thinkingClickCollapse = true
  rt.agent.provider = {
    async chat(req) {
      req.onThinking?.('pikiran selesai')
      req.onText?.('jawaban selesai')
      return { text: 'jawaban selesai', thinking: 'pikiran selesai', toolCalls: [] }
    },
    async listModels() {
      return []
    },
  }
  const { stdin, stdout, frames, lastFrame, unmount } = render(<App runtime={rt} version="test" />)
  Object.assign(stdout, { isTTY: true })
  await wait()
  stdin.write('uji scroll setelah thinking')
  await wait()
  stdin.write('\r')
  await waitFor(() => frames.some((f) => f.includes('jawaban selesai')))
  await wait(40)
  let clicked = false
  for (let y = 1; y <= 50; y++) {
    stdin.write(`\x1b[<0;12;${y}M\x1b[50;1R`)
    await wait(10)
    if ((lastFrame() ?? '').includes('pikiran selesai')) {
      clicked = true
      break
    }
  }
  expect(clicked).toBe(true)
  stdin.write('\x1b[<65;12;10M')
  await wait(30)
  const rawOut = frames.join('')
  const lastEnable = rawOut.lastIndexOf('\x1b[?1000h')
  const lastDisable = rawOut.lastIndexOf('\x1b[?1000l')
  expect(lastDisable).toBeGreaterThan(lastEnable)
  unmount()
})

test('/rewind removes the rewound turn from the visible transcript and /resume after a longer session still renders the shorter session', async () => {
  const rt = makeRuntime([
    { text: 'JAWAB_TURN_1', toolCalls: [] },
    { text: 'JAWAB_TURN_2', toolCalls: [] },
  ])
  const { stdin, lastFrame, frames, unmount } = render(<App runtime={rt} version="test" />)
  await wait()
  stdin.write('TANYA_TURN_1')
  await wait()
  stdin.write('\r')
  await waitFor(() => frames.some((f) => f.includes('JAWAB_TURN_1')))
  stdin.write('TANYA_TURN_2')
  await wait()
  stdin.write('\r')
  await waitFor(() => frames.some((f) => f.includes('JAWAB_TURN_2')))
  expect(lastFrame()).toContain('TANYA_TURN_2')
  expect(lastFrame()).toContain('JAWAB_TURN_2')

  await slash(stdin, '/rewind 1')
  await waitFor(() => frames.some((f) => f.includes('1 giliran di-rewind')))
  expect(lastFrame()).toContain('TANYA_TURN_1')
  expect(lastFrame()).toContain('JAWAB_TURN_1')
  expect(lastFrame()).not.toContain('TANYA_TURN_2')
  expect(lastFrame()).not.toContain('JAWAB_TURN_2')
  unmount()
})

test('menu slash commands (/help, /model, /thinking) execute immediately while AI is thinking instead of being queued, and Esc closes menu without aborting turn', async () => {
  const rt = makeRuntime([])
  let releaseTurn: (() => void) | undefined
  let started = false
  rt.agent.provider = {
    async chat(req) {
      started = true
      req.onThinking?.('PIKIRAN_SEDANG_JALAN_19_BARIS')
      await new Promise<void>((r) => {
        releaseTurn = r
      })
      req.onText?.('JAWABAN_SETELAH_MENU')
      return { text: 'JAWABAN_SETELAH_MENU', thinking: 'PIKIRAN_SEDANG_JALAN_19_BARIS', toolCalls: [] }
    },
    async listModels() {
      return ['glm-5.3-flash', 'kimi-k3']
    },
  }
  const { stdin, lastFrame, frames, unmount } = render(<App runtime={rt} version="test" />)
  await wait()
  stdin.write('buat aplikasi multimedia')
  await wait()
  stdin.write('\r')
  // Giliran sudah berjalan begitu provider dipanggil; panel thinking tidak dirender saat thinkingVisible=false.
  await waitFor(() => started)

  // Run /help while AI is still thinking -> must show help immediately, NOT "queued: /help"
  await slash(stdin, '/help')
  await waitFor(() => frames.some((f) => f.includes('/model')))
  expect(lastFrame()).not.toContain('queued: /help')
  expect(lastFrame()).not.toContain('antri: /help')

  // Picker menanyakan daftar model ke provider jaringan; di tes offline ia menampilkan baris gagal.
  // Yang penting diuji: picker TERBUKA seketika (tidak diantrikan), bukan isi daftar modelnya.
  await slash(stdin, '/model')
  await waitFor(() => /Pilih model|Choose a model|tidak bisa dihubungi|could not be reached|kimi-k3/i.test(lastFrame() ?? ''))
  expect(lastFrame()).not.toContain('queued: /model')
  expect(lastFrame()).not.toContain('antri: /model')

  // Pressing Esc closes ModelPicker without cancelling the running AI turn
  stdin.write('\x1b')
  await wait()
  expect(lastFrame()).not.toContain('Pilih model')
  expect(lastFrame()).not.toContain('Choose a model')
  expect(lastFrame()).not.toContain('Dibatalkan.')
  expect(lastFrame()).not.toContain('Cancelled.')

  // Pressing Tab on empty prompt, Alt+T (Termius-safe shortcut), or running /thinking toggles Thinking immediately while AI is thinking
  stdin.write('\t')
  await waitFor(() => (lastFrame() ?? '').includes('PIKIRAN_SEDANG_JALAN_19_BARIS'))
  stdin.write('\t')
  await waitFor(() => !(lastFrame() ?? '').includes('PIKIRAN_SEDANG_JALAN_19_BARIS'))
  stdin.write('\x1bt')
  await waitFor(() => (lastFrame() ?? '').includes('PIKIRAN_SEDANG_JALAN_19_BARIS'))
  await slash(stdin, '/thinking')
  await waitFor(() => !(lastFrame() ?? '').includes('PIKIRAN_SEDANG_JALAN_19_BARIS'))

  releaseTurn?.()
  await waitFor(() => frames.some((f) => f.includes('JAWABAN_SETELAH_MENU')))
  unmount()
})

test('2-finger touchpad wheel during active mouse reporting immediately releases ?1000l so native terminal scroll works', async () => {
  const rt = makeRuntime([])
  rt.config.thinkingClickCollapse = true
  let releaseTurn: (() => void) | undefined
  rt.agent.provider = {
    async chat(req) {
      req.onThinking?.('pikiran panjang')
      await new Promise<void>((r) => {
        releaseTurn = r
      })
      return { text: 'selesai', thinking: 'pikiran panjang', toolCalls: [] }
    },
    async listModels() {
      return []
    },
  }
  const { stdin, stdout, frames, lastFrame, unmount } = render(<App runtime={rt} version="test" />)
  Object.assign(stdout, { isTTY: true })
  await wait()
  stdin.write('tes wheel')
  await wait()
  stdin.write('\r')
  await waitFor(() => (lastFrame() ?? '').includes('klik untuk buka/tutup'))
  await wait(40)
  expect(frames.join('')).toContain('\x1b[?1000h')
  // Send a 2-finger touchpad scroll down packet
  stdin.write('\x1b[<65;20;10M')
  await wait(30)
  const raw = frames.join('')
  expect(raw.lastIndexOf('\x1b[?1000l')).toBeGreaterThan(raw.lastIndexOf('\x1b[?1000h'))
  releaseTurn?.()
  await waitFor(() => rt.agent.messages.some((m) => typeof m.content === 'string' && m.content.includes('selesai')))
  unmount()
})
