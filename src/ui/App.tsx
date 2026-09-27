import { homedir } from 'node:os'
import { Box, Static, Text, useApp, useInput } from 'ink'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentEvent, PermissionAnswer, PermissionAsk } from '../agent'
import { readFileSync } from 'node:fs'
import { expandCommand, parseSlash, SLASH_COMMANDS } from '../commands'
import { parseFrontmatter } from '../extensions'
import type { PermissionMode } from '../config'
import { nextMode } from '../permissions'
import type { Runtime } from '../setup'
import { Markdown } from './Markdown'
import type { ModelGroup } from '../models'
import { PRESETS } from '../presets'
import { hasKey, providerName, writeGlobalConfig } from '../providers'
import { LinePrompt } from './LinePrompt'
import { ModelPicker } from './ModelPicker'
import { type ProviderEntry, ProviderMenu } from './ProviderMenu'
import { PermissionPrompt } from './PermissionPrompt'
import { PromptInput } from './PromptInput'
import { Spinner } from './Spinner'
import { StatusBar } from './StatusBar'
import { ACCENT, color } from './theme'
import { TodoList } from './TodoList'
import { ToolBlock } from './ToolBlock'
import { applyEvent, type Entry, endTurn, entry, type Transcript } from './transcript'


function helpText(runtime: Runtime): string {
  const custom = runtime.commands.filter((c) => !SLASH_COMMANDS.some((b) => b.name === c.name))
  return [
    ...SLASH_COMMANDS.map((c) => `/${c.name.padEnd(8)} ${c.description}`),
    ...(custom.length ? ['', 'Perintah custom:', ...custom.map((c) => `/${c.name.padEnd(8)} ${c.description ?? ''}`)] : []),
    ...(runtime.skills.length ? ['', 'Skill:', ...runtime.skills.map((s) => `/${s.name.padEnd(8)} ${s.description.slice(0, 60)}`)] : []),
    '',
    'shift+tab  ganti mode izin    esc  batalkan giliran',
    'ctrl+o     output alat terakhir lengkap    \\ + enter  baris baru',
    '@file + tab  lengkapi nama file    ↑↓  riwayat input',
  ].join('\n')
}

const labelFor = (runtime: Runtime, ref: string) => `${ref.slice(ref.indexOf('/') + 1)} · ${runtime.providerLabel()}`

export function App({ runtime, initialPrompt, version }: { runtime: Runtime; initialPrompt?: string; version: string }) {
  const { exit } = useApp()
  const [transcript, setTranscript] = useState<Transcript>(() => ({ done: [entry({ kind: 'header' })], live: [] }))
  const [busy, setBusy] = useState(false)
  const [startedAt, setStartedAt] = useState(0)
  const [mode, setMode] = useState<PermissionMode>(runtime.agent.permissions.mode)
  const [tokens, setTokens] = useState(runtime.agent.totalUsage.inputTokens + runtime.agent.totalUsage.outputTokens)
  const [pending, setPending] = useState<{ request: PermissionAsk; resolve(a: PermissionAnswer): void } | null>(
    null,
  )
  const [picker, setPicker] = useState<ModelGroup[] | null>(null)
  const [providerMenu, setProviderMenu] = useState<ProviderEntry[] | null>(null)
  const [prompt, setPrompt] = useState<{ label: string; mask?: boolean; resolve(v: string | undefined): void } | null>(null)
  const ask = (label: string, mask = false) => new Promise<string | undefined>((resolve) => setPrompt({ label, mask, resolve }))
  const [modelLabel, setModelLabel] = useState(() => labelFor(runtime, runtime.modelRef))
  const [history, setHistory] = useState<string[]>([])
  const controller = useRef<AbortController | null>(null)
  const [todos, setTodos] = useState(runtime.todos.items)
  useEffect(() => runtime.todos.subscribe(setTodos), [runtime])
  const extraCommands = [
    ...runtime.commands.map((c) => ({ name: c.name, description: c.description ?? 'perintah custom' })),
    ...runtime.skills
      .filter((s) => !runtime.commands.some((c) => c.name === s.name))
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
    runtime.agent.askPermission = (request) => new Promise((resolve) => setPending({ request, resolve }))
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

  const runSlash = useCallback(
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
    [runtime, notice, exit],
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
      const command = runtime.commands.find((c) => c.name === slash.name)
      const skill = runtime.skills.find((s) => s.name === slash.name)
      if (SLASH_COMMANDS.some((b) => b.name === slash.name) || (!command && !skill)) void runSlash(slash.name, slash.args)
      else if (command) void runTurn(expandCommand(command, slash.args))
      else if (skill) void runTurn(`${parseFrontmatter(readFileSync(skill.file, 'utf8')).body}\n\nARGUMENTS: ${slash.args}`)
    },
    [runSlash, runTurn, runtime],
  )

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
    } else if (key.ctrl && input === 'o' && lastTool.current) {
      const t = lastTool.current
      notice(`⎿ ${t.tool} ${t.target}\n${t.output}`)
    }
  })

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
    setPending(null)
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
          <ToolBlock key={e.id} tool={e.tool} target={e.target} output={e.output} display={e.display} isError={e.isError} done={e.done} />
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
      {busy && !pending ? (
        <Box marginTop={1}>
          <Spinner label="Berpikir" startedAt={startedAt} />
        </Box>
      ) : null}
      {pending ? <PermissionPrompt request={pending.request} onAnswer={answer} /> : null}
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
      <TodoList items={todos} />
      <PromptInput disabled={busy || !!pending || !!picker || !!providerMenu || !!prompt} history={history} cwd={runtime.cwd} onSubmit={submit} extraCommands={extraCommands} />
      <StatusBar mode={mode} tokens={tokens} busy={busy} model={modelLabel} />
    </Box>
  )
}
