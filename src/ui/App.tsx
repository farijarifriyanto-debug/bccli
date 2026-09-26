import { homedir } from 'node:os'
import { Box, Static, Text, useApp, useInput } from 'ink'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentEvent, PermissionAnswer, PermissionAsk } from '../agent'
import { parseSlash, SLASH_COMMANDS } from '../commands'
import type { PermissionMode } from '../config'
import { nextMode } from '../permissions'
import type { Runtime } from '../setup'
import { Markdown } from './Markdown'
import { ModelPicker } from './ModelPicker'
import { PermissionPrompt } from './PermissionPrompt'
import { PromptInput } from './PromptInput'
import { Spinner } from './Spinner'
import { StatusBar } from './StatusBar'
import { ACCENT, color } from './theme'
import { ToolBlock } from './ToolBlock'

type Entry = { id: number } & (
  | { kind: 'header' }
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string }
  | { kind: 'tool'; callId: string; tool: string; target: string; output?: string; display?: string; isError?: boolean; done: boolean }
  | { kind: 'notice'; text: string; tone: 'info' | 'warn' | 'error' }
)

let nextId = 0
type EntryInput = Entry extends infer E ? (E extends { id: number } ? Omit<E, 'id'> : never) : never
const entry = (e: EntryInput): Entry => ({ ...e, id: nextId++ }) as Entry

const HELP = [
  ...SLASH_COMMANDS.map((c) => `/${c.name.padEnd(8)} ${c.description}`),
  '',
  'shift+tab  ganti mode izin    esc  batalkan giliran',
  'ctrl+o     output alat terakhir lengkap    \\ + enter  baris baru',
  '@file + tab  lengkapi nama file    ↑↓  riwayat input',
].join('\n')

export function App({ runtime, initialPrompt, version }: { runtime: Runtime; initialPrompt?: string; version: string }) {
  const { exit } = useApp()
  const [done, setDone] = useState<Entry[]>(() => [entry({ kind: 'header' })])
  const [live, setLive] = useState<Entry[]>([])
  const [busy, setBusy] = useState(false)
  const [startedAt, setStartedAt] = useState(0)
  const [mode, setMode] = useState<PermissionMode>(runtime.agent.permissions.mode)
  const [tokens, setTokens] = useState(runtime.agent.totalUsage.inputTokens + runtime.agent.totalUsage.outputTokens)
  const [pending, setPending] = useState<{ request: PermissionAsk; resolve(a: PermissionAnswer): void } | null>(
    null,
  )
  const [picker, setPicker] = useState<string[] | null>(null)
  const [history, setHistory] = useState<string[]>([])
  const controller = useRef<AbortController | null>(null)
  const lastTool = useRef<{ tool: string; target: string; output: string } | null>(null)

  const notice = useCallback((text: string, tone: 'info' | 'warn' | 'error' = 'info') => {
    setDone((d) => [...d, entry({ kind: 'notice', text, tone })])
  }, [])

  const onEvent = useCallback((event: AgentEvent) => {
    switch (event.type) {
      case 'text':
        setLive((l) => {
          const last = l.at(-1)
          if (last?.kind === 'assistant') return [...l.slice(0, -1), { ...last, text: last.text + event.delta }]
          return [...l, entry({ kind: 'assistant', text: event.delta })]
        })
        break
      case 'toolStart':
        setLive((l) => [...l, entry({ kind: 'tool', callId: event.id, tool: event.tool, target: event.target, done: false })])
        break
      case 'toolEnd':
        setLive((l) =>
          l.map((e) => {
            if (e.kind !== 'tool' || e.callId !== event.id) return e
            lastTool.current = { tool: event.tool, target: e.target, output: event.output }
            return { ...e, output: event.output, display: event.display, isError: event.isError, done: true }
          }),
        )
        break
      case 'usage':
        setTokens(event.inputTokens + event.outputTokens)
        break
      case 'compacted':
        setLive((l) => [...l, entry({ kind: 'notice', text: 'Percakapan diringkas agar muat di konteks model.', tone: 'info' })])
        break
      case 'stepLimit':
        setLive((l) => [...l, entry({ kind: 'notice', text: 'Batas 50 langkah tercapai. Ketik "lanjut" untuk meneruskan.', tone: 'warn' })])
        break
      case 'aborted':
        setLive((l) => [...l, entry({ kind: 'notice', text: 'Dibatalkan.', tone: 'warn' })])
        break
      case 'error':
        setLive((l) => [...l, entry({ kind: 'notice', text: `Error: ${event.message}`, tone: 'error' })])
        break
    }
  }, [])

  useEffect(() => {
    runtime.agent.onEvent = onEvent
    runtime.agent.askPermission = (request) => new Promise((resolve) => setPending({ request, resolve }))
  }, [runtime, onEvent])

  const runTurn = useCallback(
    async (text: string) => {
      setDone((d) => [...d, entry({ kind: 'user', text })])
      setBusy(true)
      setStartedAt(Date.now())
      controller.current = new AbortController()
      await runtime.agent.run(text, controller.current.signal)
      controller.current = null
      setLive((l) => {
        setDone((d) => [...d, ...l])
        return []
      })
      setBusy(false)
    },
    [runtime],
  )

  const runSlash = useCallback(
    async (name: string, args: string) => {
      switch (name) {
        case 'help':
          notice(HELP)
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
          try {
            await runtime.agent.compact(new AbortController().signal)
          } catch (error) {
            notice(`Gagal meringkas: ${(error as Error).message}`, 'error')
          }
          setBusy(false)
          return
        }
        case 'model': {
          if (args) {
            try {
              runtime.setModel(args)
              notice(`Model: ${args}`)
            } catch (error) {
              notice((error as Error).message, 'error')
            }
            return
          }
          try {
            const provider = runtime.modelRef.slice(0, runtime.modelRef.indexOf('/'))
            const models = await runtime.agent.provider.listModels()
            setPicker(models.map((m) => `${provider}/${m}`))
          } catch (error) {
            notice(`Tidak bisa mengambil daftar model: ${(error as Error).message}`, 'error')
          }
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
      if (slash) void runSlash(slash.name, slash.args)
      else void runTurn(text)
    },
    [runSlash, runTurn],
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
              <Text dimColor>{` · ${runtime.modelRef} · ${cwd}`}</Text>
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
      <Static items={done}>{renderEntry}</Static>
      {live.map(renderEntry)}
      {busy && !pending ? (
        <Box marginTop={1}>
          <Spinner label="Berpikir" startedAt={startedAt} />
        </Box>
      ) : null}
      {pending ? <PermissionPrompt request={pending.request} onAnswer={answer} /> : null}
      {picker ? (
        <ModelPicker
          models={picker}
          current={runtime.modelRef}
          onPick={(m) => {
            setPicker(null)
            if (m) void runSlash('model', m)
          }}
        />
      ) : null}
      <PromptInput disabled={busy || !!pending || !!picker} history={history} cwd={runtime.cwd} onSubmit={submit} />
      <StatusBar mode={mode} tokens={tokens} busy={busy} />
    </Box>
  )
}
