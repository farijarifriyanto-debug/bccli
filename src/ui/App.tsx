import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { Box, Static, Text, useApp, useInput } from 'ink'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentEvent, PermissionAnswer, PermissionAsk } from '../agent'
import { BUILTIN_AGENTS } from '../agents'
import { expandCommand, parseSlash, SLASH_COMMANDS } from '../commands'
import { removeCredential } from '../config'
import { Session } from '../session'
import { osc52 } from '../slash/copy'
import { gitDiff } from '../slash/diff'
import { doctorText } from '../slash/doctor'
import { exportMarkdown } from '../slash/export'
import { agentsText, sessionText, skillsText, statusText } from '../slash/info'
import { appendMemory, instructionFiles, parseMemoryArgs } from '../slash/memory'
import { parseFrontmatter } from '../extensions'
import type { PermissionMode } from '../config'
import { nextMode } from '../permissions'
import type { PlanDecision } from '../tools/plan'
import type { Runtime } from '../setup'
import { Markdown } from './Markdown'
import type { ModelGroup } from '../models'
import { PRESETS } from '../presets'
import { hasKey, providerName, writeGlobalConfig } from '../providers'
import { LinePrompt } from './LinePrompt'
import { type ListItem, ListPicker } from './ListPicker'
import { ModelPicker } from './ModelPicker'
import { type ProviderEntry, ProviderMenu } from './ProviderMenu'
import { PermissionPrompt } from './PermissionPrompt'
import { PromptInput } from './PromptInput'
import { Spinner } from './Spinner'
import { StatusBar } from './StatusBar'
import { ACCENT, color } from './theme'
import { CATALOG, fillTemplate } from '../mcp/catalog'
import { addGlobalServer, globalMcpPath, readMcpFile, removeGlobalServer } from '../mcp/config'
import { McpMenu, type McpMenuItem } from './McpMenu'
import { PlanApproval } from './PlanApproval'
import { TodoList } from './TodoList'
import { ToolBlock } from './ToolBlock'
import { applyEvent, type Entry, endTurn, entry, type Transcript } from './transcript'


function helpText(runtime: Runtime): string {
  const custom = runtime.commands.filter((c) => !SLASH_COMMANDS.some((b) => b.name === c.name))
  return [
    ...SLASH_COMMANDS.map((c) => `/${c.name.padEnd(12)} ${c.description}`),
    ...(custom.length ? ['', 'Perintah custom:', ...custom.map((c) => `/${c.name.padEnd(8)} ${c.description ?? ''}`)] : []),
    ...(runtime.skills.length ? ['', 'Skill:', ...runtime.skills.map((s) => `/${s.name.padEnd(8)} ${s.description.slice(0, 60)}`)] : []),
    '',
    'shift+tab  ganti mode izin    esc  batalkan giliran',
    'ctrl+o     output alat terakhir lengkap    \\ + enter  baris baru',
    '@file + tab  lengkapi nama file    ↑↓  riwayat input',
  ].join('\n')
}

const INIT_PROMPT =
  'Pelajari project ini (struktur folder, file package/build, perintah test dan lint, konvensi kode yang terlihat). Lalu buat AGENTS.md di root project, atau perbarui bila sudah ada, berisi: cara build, test, dan lint; struktur singkat; konvensi penting. Ringkas dan faktual, hanya yang benar-benar ada di project.'

const labelFor = (runtime: Runtime, ref: string) => `${ref.slice(ref.indexOf('/') + 1)} · ${runtime.providerLabel()}`

export function App({ runtime, initialPrompt, version }: { runtime: Runtime; initialPrompt?: string; version: string }) {
  const { exit } = useApp()
  const [transcript, setTranscript] = useState<Transcript>(() => ({ done: [entry({ kind: 'header' })], live: [] }))
  const [busy, setBusy] = useState(false)
  const [startedAt, setStartedAt] = useState(0)
  const [mode, setMode] = useState<PermissionMode>(runtime.agent.permissions.mode)
  const [tokens, setTokens] = useState(runtime.agent.totalUsage.inputTokens + runtime.agent.totalUsage.outputTokens)
  // Parallel tools (e.g. two subagents) can ask at the same time: queue them, show one at a time.
  const [asks, setAsks] = useState<{ id: number; request: PermissionAsk; resolve(a: PermissionAnswer): void }[]>([])
  const pending = asks[0] ?? null
  const askId = useRef(0)
  const [picker, setPicker] = useState<ModelGroup[] | null>(null)
  const [providerMenu, setProviderMenu] = useState<ProviderEntry[] | null>(null)
  const [prompt, setPrompt] = useState<{ label: string; mask?: boolean; resolve(v: string | undefined): void } | null>(null)
  const ask = useCallback((label: string, mask = false) => new Promise<string | undefined>((resolve) => setPrompt({ label, mask, resolve })), [])
  const [modelLabel, setModelLabel] = useState(() => labelFor(runtime, runtime.modelRef))
  const [history, setHistory] = useState<string[]>([])
  const controller = useRef<AbortController | null>(null)
  const [todos, setTodos] = useState(runtime.todos.items)
  const [mcpMenu, setMcpMenu] = useState<McpMenuItem[] | null>(null)
  const [listPicker, setListPicker] = useState<{ title: string; items: ListItem[]; onPick(id?: string): void } | null>(null)
  const [planAsk, setPlanAsk] = useState<{ plan: string; resolve(d: PlanDecision): void } | null>(null)
  // Messages typed while the agent works; each runs after the turn before it.
  const [queued, setQueued] = useState<string[]>([])
  useEffect(() => runtime.todos.subscribe(setTodos), [runtime])
  const extraCommands = [
    ...runtime.commands
      .filter((c) => !SLASH_COMMANDS.some((b) => b.name === c.name.toLowerCase()))
      .map((c) => ({ name: c.name.toLowerCase(), description: c.description ?? 'perintah custom' })),
    ...runtime.skills
      .filter((s) => !runtime.commands.some((c) => c.name.toLowerCase() === s.name.toLowerCase()))
      .filter((s) => !SLASH_COMMANDS.some((b) => b.name === s.name.toLowerCase()))
      .map((s) => ({ name: s.name, description: `skill · ${s.description.slice(0, 50)}` })),
  ]
  const lastTool = useRef<{ tool: string; target: string; output: string } | null>(null)
  const toolTargets = useRef(new Map<string, string>())

  const notice = useCallback((text: string, tone: 'info' | 'warn' | 'error' = 'info') => {
    setTranscript((t) => ({ ...t, done: [...t.done, entry({ kind: 'notice', text, tone })] }))
  }, [])

  const onEvent = useCallback((event: AgentEvent) => {
    if (event.type === 'toolStart') toolTargets.current.set(event.id, event.target)
    if (event.type === 'toolEnd') {
      lastTool.current = { tool: event.tool, target: toolTargets.current.get(event.id) ?? '', output: event.output }
    }
    if (event.type === 'usage') setTokens(event.inputTokens + event.outputTokens)
    setTranscript((t) => applyEvent(t, event))
  }, [])

  useEffect(() => {
    runtime.agent.onEvent = onEvent
    runtime.agent.askPermission = (request) =>
      new Promise((resolve) => setAsks((q) => [...q, { id: askId.current++, request, resolve }]))
    runtime.interaction.approvePlan = (plan) => new Promise((resolve) => setPlanAsk({ plan, resolve }))
  }, [runtime, onEvent])

  const runTurn = useCallback(
    async (text: string) => {
      setTranscript((t) => ({ ...t, done: [...t.done, entry({ kind: 'user', text })] }))
      setBusy(true)
      setStartedAt(Date.now())
      controller.current = new AbortController()
      await runtime.agent.run(text, controller.current.signal)
      controller.current = null
      setTranscript(endTurn)
      setBusy(false)
    },
    [runtime],
  )

  const runSlashCommand = useCallback(
    async (name: string, args: string) => {
      switch (name) {
        case 'help':
          notice(helpText(runtime))
          return
        case 'exit':
          exit()
          return
        case 'clear':
          runtime.agent.clear()
          setTokens(0)
          notice('Percakapan dikosongkan.')
          return
        case 'cost': {
          const u = runtime.agent.totalUsage
          notice(`${u.inputTokens.toLocaleString('id-ID')} token masuk · ${u.outputTokens.toLocaleString('id-ID')} token keluar`)
          return
        }
        case 'compact': {
          setBusy(true)
          setStartedAt(Date.now())
          controller.current = new AbortController() // so Esc can cancel it
          try {
            await runtime.agent.compact(controller.current.signal)
          } catch (error) {
            notice(`Gagal meringkas: ${(error as Error).message}`, 'error')
          }
          controller.current = null
          setBusy(false)
          return
        }
        case 'model': {
          if (args) {
            try {
              runtime.setModel(args)
              writeGlobalConfig({ model: args }, runtime.env)
              setModelLabel(labelFor(runtime, args))
              notice(`Model: ${args} (tersimpan sebagai default)`)
            } catch (error) {
              notice((error as Error).message, 'error')
            }
            return
          }
          try {
            setPicker(await runtime.listModels())
          } catch (error) {
            notice(`Tidak bisa mengambil daftar model: ${(error as Error).message}`, 'error')
          }
          return
        }
        case 'mcp': {
          const installed = readMcpFile(globalMcpPath(runtime.home))
          const states = runtime.mcp.states()
          const items = [
            ...CATALOG.map((c) => ({ name: c.name, description: c.description, installed: !!installed[c.name] })),
            ...Object.keys(installed)
              .filter((n) => !CATALOG.some((c) => c.name === n))
              .map((n) => ({ name: n, description: '(custom)', installed: true })),
          ].map((i) => {
            const s = states.find((st) => st.name === i.name)
            return { ...i, status: (s?.status ?? 'off') as McpMenuItem['status'], error: s?.error }
          })
          setMcpMenu(items)
          return
        }
        case 'new':
          runtime.newSession()
          setTokens(0)
          notice('Sesi baru dimulai. Sesi sebelumnya tetap tersimpan (/resume).')
          return
        case 'session':
          notice(
            sessionText({
              file: runtime.session.file,
              started: runtime.startedAt,
              messages: runtime.agent.messages.length,
              usage: runtime.agent.totalUsage,
              modelRef: runtime.modelRef,
            }),
          )
          return
        case 'resume': {
          const others = Session.list(runtime.home, runtime.cwd).filter((s) => s.session.file !== runtime.session.file)
          if (!others.length) {
            notice('Belum ada sesi lain di folder ini.')
            return
          }
          setListPicker({
            title: 'Lanjutkan sesi',
            items: others.map((s) => ({
              id: s.session.file,
              label: `${s.mtime.toLocaleString('id-ID')}  ${s.preview || '(kosong)'}`,
              hint: `${s.session.load().length} pesan`,
            })),
            onPick: (id) => {
              setListPicker(null)
              const chosen = others.find((s) => s.session.file === id)
              if (!chosen) return
              runtime.resume(chosen.session)
              setTokens(0)
              const tail = runtime.agent.messages.filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content).slice(-3)
              notice(
                [`Melanjutkan sesi (${runtime.agent.messages.length} pesan):`, ...tail.map((m) => `${m.role === 'user' ? '>' : '●'} ${String(m.content).slice(0, 200)}`)].join(
                  '\n',
                ),
              )
            },
          })
          return
        }
        case 'status':
          notice(
            statusText({
              version,
              modelRef: runtime.modelRef,
              providerLabel: runtime.providerLabel(),
              mode: runtime.agent.permissions.mode,
              cwd: runtime.cwd,
              mcp: runtime.mcp.states(),
              usage: runtime.agent.totalUsage,
              lastInputTokens: runtime.agent.lastInputTokens,
            }),
          )
          return
        case 'agents':
          notice(agentsText([...BUILTIN_AGENTS, ...runtime.agentDefs]))
          return
        case 'skills':
          notice(skillsText(runtime.skills, runtime.commands))
          return
        case 'doctor': {
          notice('Memeriksa…')
          const c = runtime.config
          notice(
            await doctorText(
              {
                providers: Object.keys(c.providers).map((id) => ({ id, name: providerName(c, id), ready: hasKey(c, id, runtime.env) })),
                mcp: runtime.mcp.states(),
                activeProvider: runtime.providerLabel(),
              },
              {
                which: (cmd) => new Promise((done) => execFile(process.platform === 'win32' ? 'where' : 'which', [cmd], (error) => done(!error))),
                nodeVersion: process.version,
                listModels: () => runtime.agent.provider.listModels(),
              },
            ),
          )
          return
        }
        case 'permissions': {
          const rules = runtime.agent.permissions.list()
          if (!rules.length) {
            notice('Belum ada izin tersimpan. Izin dari jawaban [a] dan dari config akan muncul di sini.')
            return
          }
          setListPicker({
            title: 'Izin aktif (enter: cabut izin sesi)',
            items: rules.map((r) => ({ id: r.rule, label: r.rule, hint: r.source === 'config' ? 'config' : 'sesi ini' })),
            onPick: (id) => {
              setListPicker(null)
              const rule = rules.find((r) => r.rule === id)
              if (!rule) return
              if (rule.source === 'config') notice(`${rule.rule} berasal dari config/flag; hapus dari ~/.bccli/config.json untuk mencabutnya.`, 'warn')
              else {
                runtime.agent.permissions.revoke(rule.rule)
                notice(`Izin ${rule.rule} dicabut.`)
              }
            },
          })
          return
        }
        case 'memory': {
          if (!args) {
            const files = instructionFiles(runtime.cwd, runtime.home)
            notice(files.length ? files.map((f) => `${f.path} (${f.lines} baris)`).join('\n') : 'Belum ada AGENTS.md / BCCLI.md. Tambah dengan /memory <teks>.')
            return
          }
          const { global, text } = parseMemoryArgs(args)
          if (!text) {
            notice('Tulis teksnya: /memory global <teks>.', 'warn')
            return
          }
          const file = global ? join(runtime.home, 'BCCLI.md') : join(runtime.cwd, 'AGENTS.md')
          try {
            mkdirSync(dirname(file), { recursive: true })
            appendMemory(file, text)
          } catch (error) {
            notice(`Gagal menulis ${file}: ${(error as Error).message}`, 'error')
            return
          }
          runtime.rebuildSystemPrompt()
          notice(`Ditambahkan ke ${file}.`)
          return
        }
        case 'init':
          void runTurn(INIT_PROMPT)
          return
        case 'login': {
          const id = runtime.modelRef.slice(0, runtime.modelRef.indexOf('/'))
          const key = await ask(`API key untuk ${runtime.providerLabel()}`, true)
          if (!key) return
          const result = await runtime.addProviderKey(id, key)
          if (!result.ok) {
            notice(result.error, 'error')
            return
          }
          runtime.setModel(runtime.modelRef) // pick up the new key
          const envName = runtime.config.providers[id]?.apiKeyEnv
          if (envName && runtime.env[envName]) {
            notice(`Key ${runtime.providerLabel()} tersimpan, tapi ${envName} di environment lebih diutamakan dan tetap dipakai.`, 'warn')
            return
          }
          notice(`Key ${runtime.providerLabel()} tersimpan · ${result.models} model.`)
          return
        }
        case 'logout': {
          const id = runtime.modelRef.slice(0, runtime.modelRef.indexOf('/'))
          const removed = removeCredential(id, runtime.env)
          const envName = runtime.config.providers[id]?.apiKeyEnv
          if (envName && runtime.env[envName]) {
            notice(
              `${removed ? 'Key tersimpan dihapus, tapi' : 'Tidak ada key tersimpan;'} ${envName} masih ada di environment dan tetap dipakai.`,
              'warn',
            )
            return
          }
          if (!removed) {
            notice(`Tidak ada key tersimpan untuk ${runtime.providerLabel()}.`)
            return
          }
          try {
            runtime.setModel(runtime.modelRef)
          } catch (error) {
            // No key left: stop using the one still held in memory.
            const fail = async (): Promise<never> => {
              throw error
            }
            runtime.agent.provider = { chat: fail, listModels: fail }
          }
          notice(`Key ${runtime.providerLabel()} dihapus. Pakai /login atau /provider untuk menambah lagi.`)
          return
        }
        case 'diff':
          notice(await gitDiff(runtime.cwd))
          return
        case 'undo': {
          const result = await runtime.checkpoints.undo()
          if (!result) {
            notice('Tidak ada edit file yang bisa dibatalkan.')
            return
          }
          const rel = (p: string) => relative(runtime.cwd, p) || p
          notice(
            [
              result.failed.length ? `Gagal dikembalikan: ${result.failed.map(rel).join(', ')}` : '',
              result.restored.length ? `Dikembalikan: ${result.restored.map(rel).join(', ')}` : '',
              result.deleted.length ? `Dihapus (file baru): ${result.deleted.map(rel).join(', ')}` : '',
              result.skipped.length ? `Terlalu besar untuk disimpan, tidak diubah: ${result.skipped.map(rel).join(', ')}` : '',
              'Catatan: perubahan lewat perintah bash tidak bisa di-undo.',
            ]
              .filter(Boolean)
              .join('\n'),
          )
          return
        }
        case 'copy': {
          const last = runtime.agent.messages.findLast((m) => m.role === 'assistant' && typeof m.content === 'string' && m.content.trim())
          if (!last || typeof last.content !== 'string') {
            notice('Belum ada jawaban untuk disalin.')
            return
          }
          process.stdout.write(osc52(last.content, !!process.env.TMUX))
          const file = join(runtime.home, 'last-answer.md')
          mkdirSync(runtime.home, { recursive: true })
          writeFileSync(file, last.content)
          notice(`Disalin ke clipboard (bila terminal mendukung OSC 52) dan disimpan di ${file}.`)
          return
        }
        case 'export': {
          const name = args || `bccli-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.md`
          const file = resolve(runtime.cwd, name)
          if (existsSync(file)) {
            const answer = await ask(`${file} sudah ada. Timpa? (y/N)`)
            if (!answer || !/^y(a|es)?$/i.test(answer.trim())) {
              notice('Ekspor dibatalkan.')
              return
            }
          }
          try {
            writeFileSync(file, exportMarkdown(runtime.agent.messages, `Sesi BCCLI ${runtime.startedAt.toLocaleString('id-ID')}`))
          } catch (error) {
            notice(`Gagal menulis ${file}: ${(error as Error).message}`, 'error')
            return
          }
          notice(`Percakapan disimpan di ${file}.`)
          return
        }
        case 'provider': {
          const c = runtime.config
          setProviderMenu(
            Object.keys(c.providers).map((id) => ({ id, name: providerName(c, id), ready: hasKey(c, id, runtime.env), baseURL: c.providers[id].baseURL })),
          )
          return
        }
        default:
          notice(`Perintah tidak dikenal: /${name}. Ketik /help.`, 'warn')
      }
    },
    [runtime, notice, exit, version, runTurn, ask],
  )
  // A failing command (locked file, unwritable folder) must not take the whole app down.
  const runSlash = useCallback(
    (name: string, args: string) => runSlashCommand(name, args).catch((error: Error) => notice(`/${name}: ${error.message}`, 'error')),
    [runSlashCommand, notice],
  )

  const submit = useCallback(
    (text: string) => {
      setHistory((h) => [...h, text])
      const slash = parseSlash(text)
      if (!slash) {
        void runTurn(text)
        return
      }
      // Built-ins win, then custom commands, then skills.
      // parseSlash lowercases the typed name, so match file names case-insensitively.
      const command = runtime.commands.find((c) => c.name.toLowerCase() === slash.name)
      const skill = runtime.skills.find((s) => s.name.toLowerCase() === slash.name)
      if (SLASH_COMMANDS.some((b) => b.name === slash.name) || (!command && !skill)) void runSlash(slash.name, slash.args)
      else if (command) void runTurn(expandCommand(command, slash.args))
      else if (skill) {
        let body: string
        try {
          body = parseFrontmatter(readFileSync(skill.file, 'utf8')).body
        } catch (error) {
          notice(`Skill ${skill.name} tidak bisa dibaca: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`, 'error')
          return
        }
        void runTurn(`${body}\n\nARGUMENTS: ${slash.args}`)
      }
    },
    [runSlash, runTurn, runtime, notice],
  )

  const onPrompt = useCallback(
    (text: string) => {
      if (busy) setQueued((q) => [...q, text])
      else submit(text)
    },
    [busy, submit],
  )

  useEffect(() => {
    if (busy || pending || planAsk || !queued.length) return
    const [next, ...rest] = queued
    setQueued(rest)
    submit(next)
  }, [busy, pending, planAsk, queued, submit])

  const initialSent = useRef(false)
  useEffect(() => {
    if (initialPrompt && !initialSent.current) {
      initialSent.current = true
      submit(initialPrompt)
    }
  }, [initialPrompt, submit])

  useInput((input, key) => {
    if (key.tab && key.shift) {
      const next = nextMode(runtime.agent.permissions.mode)
      runtime.agent.permissions.mode = next
      setMode(next)
    } else if (key.escape && busy && !pending) {
      controller.current?.abort()
      if (queued.length) {
        setQueued([])
        notice(`${queued.length} pesan antrian dibatalkan.`, 'warn')
      }
    } else if (key.ctrl && input === 'o' && lastTool.current) {
      const t = lastTool.current
      notice(`⎿ ${t.tool} ${t.target}\n${t.output}`)
    }
  })

  const pickMcp = async (name: string | undefined) => {
    const item = mcpMenu?.find((i) => i.name === name)
    setMcpMenu(null)
    if (!item) return
    if (item.installed) {
      removeGlobalServer(runtime.home, item.name)
      await runtime.mcp.remove(item.name)
      notice(`MCP ${item.name} dihapus.`)
      return
    }
    const entry = CATALOG.find((c) => c.name === item.name)
    if (!entry) return
    const values: Record<string, string> = {}
    for (const input of entry.inputs ?? []) {
      const v = await ask(input.label, !!input.secret)
      if (!v) return
      values[input.key] = v
    }
    const config = fillTemplate(entry.config, values)
    addGlobalServer(runtime.home, entry.name, config)
    notice(`MCP ${entry.name} dipasang, menghubungkan…`)
    await runtime.mcp.add({ name: entry.name, config, source: 'global' })
    const state = runtime.mcp.states().find((s) => s.name === entry.name)
    if (state?.status === 'ready') notice(`MCP ${entry.name} aktif · ${state.tools} alat.`)
    else notice(`MCP ${entry.name} gagal: ${state?.error ?? 'tidak diketahui'}`, 'error')
  }

  const pickProvider = async (id: string | 'custom' | undefined) => {
    setProviderMenu(null)
    if (!id) return
    let target = id
    if (id === 'custom') {
      const name = await ask('Id provider (huruf kecil, mis. corp)')
      const url = name ? await ask('Base URL OpenAI-compatible') : undefined
      if (!name || !url) return
      writeGlobalConfig({ providers: { [name]: { baseURL: url } } }, runtime.env)
      runtime.reloadConfig()
      target = name
    }
    const c = runtime.config
    const keyless = !c.providers[target].apiKeyEnv && PRESETS.some((p) => p.id === target)
    if (!hasKey(c, target, runtime.env) || id === 'custom') {
      const key = keyless ? '' : await ask(`API key untuk ${providerName(c, target)}`, true)
      if (key === undefined) return
      const result = await runtime.addProviderKey(target, key)
      if (!result.ok) {
        notice(result.error, 'error')
        return
      }
      notice(`${providerName(c, target)} siap · ${result.models} model.`)
    }
    setPicker(await runtime.listModels(target))
  }

  const answer = (a: PermissionAnswer) => {
    pending?.resolve(a)
    setAsks((q) => q.slice(1))
    if (a === 'all') setMode('allowAll')
  }

  const cwd = runtime.cwd.startsWith(homedir()) ? `~${runtime.cwd.slice(homedir().length)}` : runtime.cwd
  const renderEntry = (e: Entry) => {
    switch (e.kind) {
      case 'header':
        return (
          <Box key={e.id} marginBottom={1}>
            <Text>
              <Text color={color(ACCENT)} bold>
                {' ✻ '}
              </Text>
              <Text bold>{`BCCLI ${version}`}</Text>
              <Text dimColor>{` · ${runtime.modelRef} (${runtime.providerLabel()}) · ${cwd}`}</Text>
            </Text>
          </Box>
        )
      case 'user':
        return (
          <Box key={e.id} marginTop={1}>
            <Text dimColor>{`> ${e.text}`}</Text>
          </Box>
        )
      case 'assistant':
        if (!e.text.trim()) return null
        return (
          <Box key={e.id} marginTop={1}>
            <Text color={color(ACCENT)}>● </Text>
            <Markdown text={e.text.replace(/^\s+/, '')} />
          </Box>
        )
      case 'tool':
        return (
          <ToolBlock key={e.id} tool={e.tool} target={e.target} output={e.output} display={e.display} isError={e.isError} done={e.done} sub={e.sub} />
        )
      case 'notice':
        return (
          <Box key={e.id} marginTop={1}>
            <Text color={e.tone === 'error' ? color('red') : e.tone === 'warn' ? color('yellow') : undefined} dimColor={e.tone === 'info'}>
              {e.text}
            </Text>
          </Box>
        )
    }
  }

  return (
    <Box flexDirection="column">
      <Static items={transcript.done}>{renderEntry}</Static>
      {transcript.live.map(renderEntry)}
      {busy && !pending && !planAsk ? (
        <Box marginTop={1}>
          <Spinner label="Berpikir" startedAt={startedAt} />
        </Box>
      ) : null}
      {pending ? <PermissionPrompt key={pending.id} request={pending.request} onAnswer={answer} /> : null}
      {picker ? (
        <ModelPicker
          groups={picker}
          current={runtime.modelRef}
          onPick={(m) => {
            setPicker(null)
            if (m) void runSlash('model', m)
          }}
        />
      ) : null}
      {listPicker ? <ListPicker title={listPicker.title} items={listPicker.items} onPick={listPicker.onPick} /> : null}
      {mcpMenu ? <McpMenu items={mcpMenu} onPick={(n) => void pickMcp(n)} /> : null}
      {providerMenu ? <ProviderMenu entries={providerMenu} onPick={(id) => void pickProvider(id)} /> : null}
      {prompt ? (
        <LinePrompt
          label={prompt.label}
          mask={prompt.mask}
          onSubmit={(v) => {
            setPrompt(null)
            prompt.resolve(v)
          }}
          onCancel={() => {
            setPrompt(null)
            prompt.resolve(undefined)
          }}
        />
      ) : null}
      {planAsk ? (
        <PlanApproval
          plan={planAsk.plan}
          onAnswer={(d) => {
            planAsk.resolve(d)
            setPlanAsk(null)
            if (d !== 'no') setMode(d)
          }}
        />
      ) : null}
      <TodoList items={todos} />
      {queued.map((q, i) => (
        <Text key={`${i}-${q}`} dimColor>{`  ⏳ antri: ${q}`}</Text>
      ))}
      <PromptInput disabled={!!pending || !!picker || !!providerMenu || !!prompt || !!planAsk || !!mcpMenu || !!listPicker} history={history} cwd={runtime.cwd} onSubmit={onPrompt} extraCommands={extraCommands} />
      <StatusBar mode={mode} tokens={tokens} busy={busy} model={modelLabel} />
    </Box>
  )
}
