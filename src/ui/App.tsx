import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { Box, Static, Text, measureElement, useApp, useInput, useStdin, useStdout, type DOMElement } from 'ink'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentEvent, PermissionAnswer, PermissionAsk } from '../agent'
import { BUILTIN_AGENTS } from '../agents'
import { expandCommand, parseSlash, prReviewPrompt, SLASH_COMMANDS } from '../commands'
import { removeCredential } from '../config'
import { runHooks } from '../hooks'
import { renderBackgroundTasks, runCommand } from '../tools/bash'
import { resolveShell } from '../tools/shell'
import { assertReasoningSupported, parseReasoningLevel, REASONING_LEVELS, supportedReasoningLevels, type ReasoningLevel } from '../reasoning'
import { Session } from '../session'
import { osc52 } from '../slash/copy'
import { gitDiff } from '../slash/diff'
import { worktreeListText } from '../worktree'
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
import { clickedThinking, hasMouseWheelSequence, parseThinkingReports } from './thinkingMouse'
import { StatusBar } from './StatusBar'
import { ACCENT, color } from './theme'
import { isRealTty, isTtyStream, streamRows } from './tty'
import { capLiveMarkdown } from './liveCap'
import { CATALOG, fillTemplate } from '../mcp/catalog'
import { addGlobalServer, globalMcpPath, readMcpFile, removeGlobalServer } from '../mcp/config'
import { McpMenu, type McpMenuItem } from './McpMenu'
import { PlanApproval } from './PlanApproval'
import { TodoList } from './TodoList'
import { ToolBlock } from './ToolBlock'
import { toolLabel } from '../print'
import { expandAtFileMentions } from './complete'
import { replayEntries } from './replay'
import { applyEvent, type Entry, endTurn, entry, type Transcript } from './transcript'
import { getLanguage, locale, parseLang, setLanguage, t } from '../i18n'
import { matchKeybind } from '../keybinds'
import { grabClipboardImage } from '../clipboardImage'
import { MAX_VERIFY_ROUNDS, runVerify, verifyFollowup } from '../verify'


function helpText(runtime: Runtime): string {
  const custom = runtime.commands.filter((c) => !SLASH_COMMANDS.some((b) => b.name === c.name))
  const kb = runtime.config.keybinds
  return [
    ...SLASH_COMMANDS.map((c) => `/${c.name.padEnd(12)} ${t(c.description)}`),
    ...(custom.length ? ['', t('Custom commands:'), ...custom.map((c) => `/${c.name.padEnd(8)} ${c.description ?? ''}`)] : []),
    ...(runtime.skills.length ? ['', t('Skills:'), ...runtime.skills.map((s) => `/${s.name.padEnd(8)} ${s.description.slice(0, 60)}`)] : []),
    '',
    t('shift+tab  switch permission mode    esc  cancel the turn'),
    t('{bind} full output of the last tool    \\ + enter  new line', { bind: kb.toolOutput.spec.padEnd(10) }),
    t('{bind} show/hide the model’s thinking', { bind: kb.thinking.spec.padEnd(10) }),
    t('@file + tab  complete file names    ↑↓  input history'),
  ].join('\n')
}

const INIT_PROMPT =
  'Study this project (folder structure, package/build files, test and lint commands, visible code conventions). Then create AGENTS.md in the project root, or update it if it already exists, covering: how to build, test, and lint; a short structure overview; important conventions. Keep it concise and factual, only what actually exists in the project.'

const labelFor = (runtime: Runtime, ref: string) => `${ref.slice(ref.indexOf('/') + 1)} · ${runtime.providerLabel()}`

export function App({ runtime, initialPrompt, version, updateMessage }: { runtime: Runtime; initialPrompt?: string; version: string; updateMessage?: string }) {
  const { exit } = useApp()
  // bccli -c / -r load a saved conversation before the screen exists: show it, not only the header.
  const [transcript, setTranscript] = useState<Transcript>(() => ({
    done: [entry({ kind: 'header' }), ...(updateMessage ? [entry({ kind: 'notice', text: updateMessage, tone: 'warn' })] : []), ...(runtime.agent.messages.length ? replayEntries(runtime.session.loadHistory()) : [])],
    live: [],
  }))
  const [busy, setBusy] = useState(false)
  const [cancelling, setCancelling] = useState(false) // Esc was pressed; shows that it registered while the turn winds down
  const [startedAt, setStartedAt] = useState(0)
  const [mode, setMode] = useState<PermissionMode>(runtime.agent.permissions.mode)
  const [reasoning, setReasoning] = useState<ReasoningLevel>(runtime.reasoning)
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
  const [showThinking, setShowThinking] = useState(runtime.config.thinkingVisible === true)
  const showThinkingRef = useRef(showThinking)
  const [showToolOutput, setShowToolOutput] = useState(false)
  const [staticKey, setStaticKey] = useState(0)
  const [, setConfigRev] = useState(0)
  const lastUserIdx = transcript.done.findLastIndex((e) => e.kind === 'user')
  const { stdin } = useStdin()
  const { stdout } = useStdout()
  // Ink 8 no longer types `isTTY`/`rows` on the stream it hands out; ask the guards instead. Ink already re-renders
  // the tree on resize, so reading the height here is enough (no extra resize listener per app).
  const realStdout = isRealTty(stdout)
  const maxLiveLines = Math.max(8, streamRows(stdout) - 10)
  const maxSplitIdxRef = useRef(0)
  const refreshStatic = useCallback(() => {
    if (realStdout) {
      stdout.write('\x1b[2J\x1b[3J\x1b[H')
    }
    maxSplitIdxRef.current = 0
    setStaticKey((k) => k + 1)
  }, [stdout, realStdout])
  let splitIdx = Math.max(maxSplitIdxRef.current, lastUserIdx > 0 ? lastUserIdx : 0)
  if (realStdout) {
    const entryLines = (e: Entry): number => {
      if (e.kind === 'thinking') return showThinking ? Math.min(maxLiveLines, e.text.split('\n').length + 2) : 2
      if (e.kind === 'tool') return showToolOutput ? Math.min(maxLiveLines, (e.output ?? e.display ?? '').split('\n').length + 2) : 5
      if (e.kind === 'assistant' || e.kind === 'notice' || e.kind === 'user') return e.text.split('\n').length + 1
      return 2
    }
    const liveLines = transcript.live.reduce((acc, e) => acc + entryLines(e), 0)
    let doneLines = transcript.done.slice(splitIdx).reduce((acc, e) => acc + entryLines(e), 0)
    while (splitIdx < transcript.done.length - 1 && doneLines + liveLines > maxLiveLines) {
      doneLines -= entryLines(transcript.done[splitIdx])
      splitIdx++
    }
    maxSplitIdxRef.current = splitIdx
  }
  const staticDone = transcript.done.slice(0, splitIdx)
  const activeTurnDone = transcript.done.slice(splitIdx)
  const activeTurnEntries = [...activeTurnDone, ...transcript.live]
  const lastThinkingEntryId = activeTurnEntries.findLast((e) => e.kind === 'thinking' && !!e.text.trim())?.id
  const hasThinking = lastThinkingEntryId !== undefined || transcript.done.some((e) => e.kind === 'thinking' && !!e.text.trim())
  const liveRootRef = useRef<DOMElement>(null)
  const thinkingTargetRef = useRef<DOMElement>(null)
  const spinnerTargetRef = useRef<DOMElement>(null)
  const thinkingEntryRefs = useRef(new Map<number, DOMElement>())
  const [injected, setInjected] = useState<{ text: string; n: number } | undefined>()
  useEffect(() => runtime.todos.subscribe(setTodos), [runtime])
  const extraCommands = [
    ...runtime.commands
      .filter((c) => !SLASH_COMMANDS.some((b) => b.name === c.name.toLowerCase()))
      .map((c) => ({ name: c.name.toLowerCase(), description: c.description ?? t('custom command') })),
    ...runtime.skills
      .filter((s) => !runtime.commands.some((c) => c.name.toLowerCase() === s.name.toLowerCase()))
      .filter((s) => !SLASH_COMMANDS.some((b) => b.name === s.name.toLowerCase()))
      .map((s) => ({ name: s.name, description: t('skill · {description}', { description: s.description.slice(0, 50) }) })),
  ]
  const lastTool = useRef<{ tool: string; target: string; output: string } | null>(null)
  const toolTargets = useRef(new Map<string, string>())
  const editedInTurn = useRef(false)

  const notice = useCallback((text: string, tone: 'info' | 'warn' | 'error' = 'info') => {
    setTranscript((t) => ({ ...t, done: [...t.done, entry({ kind: 'notice', text, tone })] }))
  }, [])

  const onEvent = useCallback((event: AgentEvent) => {
    if (event.type === 'toolStart') toolTargets.current.set(event.id, event.target)
    if (event.type === 'toolEnd') {
      lastTool.current = { tool: event.tool, target: toolTargets.current.get(event.id) ?? '', output: event.output }
      if ((event.tool === 'edit' || event.tool === 'write') && !event.isError) editedInTurn.current = true
    }
    if (event.type === 'usage') setTokens(event.inputTokens + event.outputTokens)
    if (event.type === 'budgetExceeded') {
      notice(
        t('Budget exceeded ({kind}): {used} of {limit}. Further model calls are blocked; raise usageCap in ~/.bccli/config.json.', {
          kind: event.kind,
          used: Math.round(event.used * 100) / 100,
          limit: event.limit,
        }),
        'warn',
      )
    }
    setTranscript((t) => applyEvent(t, event))
  }, [notice])

  useEffect(() => {
    runtime.agent.onEvent = onEvent
    runtime.agent.askPermission = (request) =>
      new Promise((resolve) => setAsks((q) => [...q, { id: askId.current++, request, resolve }]))
    runtime.interaction.approvePlan = (plan) => new Promise((resolve) => setPlanAsk({ plan, resolve }))
    // Session hooks are fire-and-forget: a failing hook must never break the UI.
    runHooks(runtime.config.hooks, 'SessionStart', {}, { env: runtime.env, cwd: runtime.cwd })
      .then((outcome) => {
        for (const w of outcome.warnings) notice(w, 'warn')
      })
      .catch(() => {})
    runtime.emitPlugins('SessionStart').catch(() => {})
  }, [runtime, onEvent, notice])

  const runTurn = useCallback(
    async (text: string) => {
      setTranscript((t) => ({ ...t, done: [...t.done, entry({ kind: 'user', text })] }))
      setBusy(true)
      setShowToolOutput(false)
      setStartedAt(Date.now())
      editedInTurn.current = false
      controller.current = new AbortController()
      const signal = controller.current.signal
      const expandedText = expandAtFileMentions(text, runtime.cwd, runtime.agent.readFiles)
      await runtime.agent.run(expandedText, signal)
      const commands = runtime.config.verifyCommands
      if (editedInTurn.current && commands.length && !signal.aborted) {
        for (let round = 0; round < MAX_VERIFY_ROUNDS; round++) {
          notice(t('Verifying edits: {cmds}', { cmds: commands.join(', ') }))
          const failures = await runVerify(commands, { cwd: runtime.cwd, env: runtime.env, signal })
          if (!failures.length) {
            notice(t('Verification passed.'))
            break
          }
          if (round === MAX_VERIFY_ROUNDS - 1 || signal.aborted) {
            notice(t('Verification still failing after {n} fix round(s). Run the commands manually to see why.', { n: MAX_VERIFY_ROUNDS }), 'warn')
            break
          }
          await runtime.agent.run(verifyFollowup(failures), signal)
        }
      }
      controller.current = null
      runHooks(runtime.config.hooks, 'Stop', {}, { env: runtime.env, cwd: runtime.cwd })
        .then((outcome) => {
          for (const w of outcome.warnings) notice(w, 'warn')
        })
        .catch(() => {})
      runtime.emitPlugins('Stop').catch(() => {})
      setTranscript(endTurn)
      setBusy(false)
      setCancelling(false)
    },
    [runtime, notice],
  )

  const toggleThinking = useCallback(() => {
    // Keep this callback stable while the mouse reporter is active; the Ink
    // frame reflows on expansion and React otherwise tears the reporter down.
    const next = !showThinkingRef.current
    showThinkingRef.current = next
    setShowThinking(next)
    if (maxSplitIdxRef.current > 0) refreshStatic()
    try {
      writeGlobalConfig({ thinkingVisible: next }, runtime.env)
    } catch (error) {
      notice(t('Could not save thinking visibility: {error}', { error: (error as Error).message }), 'warn')
    }
    // Do not append to transcript.done: Ink <Static> is write-once scrollback.
  }, [runtime, notice, refreshStatic])

  const runSlashCommand = useCallback(
    async (name: string, args: string) => {
      switch (name) {
        case 'help':
          notice(helpText(runtime))
          return
        case 'thinking':
        case 't': {
          const v = args.trim().toLowerCase()
          if (v === 'on' || v === 'true') {
            if (!showThinkingRef.current) toggleThinking()
          } else if (v === 'off' || v === 'false') {
            if (showThinkingRef.current) toggleThinking()
          } else {
            toggleThinking()
          }
          return
        }
        case 'output':
        case 'o':
          setShowToolOutput((prev) => !prev)
          if (maxSplitIdxRef.current > 0) refreshStatic()
          return
        case 'exit':
        case 'quit':
          exit()
          return
        case 'clear':
          controller.current?.abort()
          controller.current = null
          setQueued([])
          setBusy(false)
          setCancelling(false)
          runtime.agent.clear()
          setTokens(0)
          setShowToolOutput(false)
          setTranscript({ done: [entry({ kind: 'header' })], live: [] })
          refreshStatic()
          notice(t('Conversation cleared.'))
          return
        case 'cost': {
          const u = runtime.agent.totalUsage
          notice(t('{input} tokens in · {output} tokens out', { input: u.inputTokens.toLocaleString(locale()), output: u.outputTokens.toLocaleString(locale()) }))
          return
        }
        case 'tasks':
          notice(renderBackgroundTasks())
          return
        case 'compact': {
          setBusy(true)
          setStartedAt(Date.now())
          controller.current = new AbortController() // so Esc can cancel it
          try {
            await runtime.agent.compact(controller.current.signal)
          } catch (error) {
            notice(t('Could not summarize: {error}', { error: (error as Error).message }), 'error')
          }
          controller.current = null
          setBusy(false)
          setCancelling(false)
          return
        }
        case 'reasoning': {
          const apply = (value: string) => {
            try {
              const level = parseReasoningLevel(value, '/reasoning')
              const providerId = runtime.modelRef.slice(0, runtime.modelRef.indexOf('/'))
              assertReasoningSupported(providerId, level)
              runtime.setReasoning(level)
              writeGlobalConfig({ reasoning: level }, runtime.env)
              setReasoning(level)
              notice(t('Reasoning: {level} (saved as default)', { level }))
            } catch (error) {
              notice((error as Error).message, 'error')
            }
          }
          if (args) {
            apply(args)
            return
          }
          const providerId = runtime.modelRef.slice(0, runtime.modelRef.indexOf('/'))
          const supported = supportedReasoningLevels(providerId)
          setListPicker({
            title: 'Reasoning',
            items: REASONING_LEVELS.map((level) => ({
              id: level,
              label: level === 'auto' ? 'Auto (model default)' : level.charAt(0).toUpperCase() + level.slice(1),
              disabled: !supported.includes(level),
              hint: supported.includes(level) ? undefined : t('not supported by this provider'),
            })),
            onPick: (id) => {
              setListPicker(null)
              if (id) apply(id)
            },
          })
          return
        }
        case 'model': {
          if (args) {
            try {
              runtime.setModel(args)
              writeGlobalConfig({ model: args }, runtime.env)
              setModelLabel(labelFor(runtime, args))
              notice(t('Model: {model} (saved as default)', { model: args }))
            } catch (error) {
              notice((error as Error).message, 'error')
            }
            return
          }
          try {
            setPicker(await runtime.listModels())
          } catch (error) {
            notice(t('Cannot fetch the model list: {error}', { error: (error as Error).message }), 'error')
          }
          return
        }
        case 'mcp': {
          const installed = readMcpFile(globalMcpPath(runtime.home))
          const states = runtime.mcp.states()
          const items = [
            ...CATALOG.map((c) => ({ name: c.name, description: t(c.description), installed: !!installed[c.name] })),
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
          controller.current?.abort()
          controller.current = null
          setQueued([])
          setBusy(false)
          setCancelling(false)
          runtime.newSession()
          setTokens(0)
          setShowToolOutput(false)
          setTranscript({ done: [entry({ kind: 'header' })], live: [] })
          refreshStatic()
          notice(t('New session started. The previous session stays saved (/resume).'))
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
            notice(t('No other sessions in this folder yet.'))
            return
          }
          setListPicker({
            title: t('Continue a session'),
            items: others.map((s) => ({
              id: s.session.file,
              label: `${s.mtime.toLocaleString(locale())}  ${s.preview || t('(empty)')}`,
              hint: t('{n} messages', { n: s.session.load().length }),
            })),
            onPick: (id) => {
              setListPicker(null)
              const chosen = others.find((s) => s.session.file === id)
              if (!chosen) return
              runtime.resume(chosen.session)
              setModelLabel(labelFor(runtime, runtime.modelRef))
              setTokens(0)
              setShowToolOutput(false)
              setTranscript({ done: [entry({ kind: 'header' }), ...replayEntries(chosen.session.loadHistory())], live: [] })
              refreshStatic()
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
              contextWindow: runtime.agent.getContextWindow(),
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
          notice(t('Checking…'))
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
            notice(t('No saved permissions yet. Permissions from [a] answers and from the config will appear here.'))
            return
          }
          setListPicker({
            title: t('Active permissions (enter: revoke a session permission)'),
            items: rules.map((r) => ({ id: r.rule, label: r.rule, hint: r.source === 'config' ? 'config' : t('this session') })),
            onPick: (id) => {
              setListPicker(null)
              const rule = rules.find((r) => r.rule === id)
              if (!rule) return
              if (rule.source === 'config') notice(t('{rule} comes from the config/flag; remove it from ~/.bccli/config.json to revoke it.', { rule: rule.rule }), 'warn')
              else {
                runtime.agent.permissions.revoke(rule.rule)
                notice(t('Permission {rule} revoked.', { rule: rule.rule }))
              }
            },
          })
          return
        }
        case 'memory': {
          if (!args) {
            const files = instructionFiles(runtime.cwd, runtime.home)
            notice(files.length ? files.map((f) => t('{path} ({lines} lines)', { path: f.path, lines: f.lines })).join('\n') : t('No AGENTS.md / BCCLI.md yet. Add one with /memory <text>.'))
            return
          }
          const { global, text } = parseMemoryArgs(args)
          if (!text) {
            notice(t('Write the text: /memory global <text>.'), 'warn')
            return
          }
          const file = global ? join(runtime.home, 'BCCLI.md') : join(runtime.cwd, 'AGENTS.md')
          try {
            mkdirSync(dirname(file), { recursive: true })
            appendMemory(file, text)
          } catch (error) {
            notice(t('Could not write {file}: {error}', { file, error: (error as Error).message }), 'error')
            return
          }
          runtime.rebuildSystemPrompt()
          notice(t('Added to {file}.', { file }))
          return
        }
        case 'init':
          void runTurn(INIT_PROMPT)
          return
        case 'language': {
          if (!args) {
            notice(t('Language: {lang}. Change it with /language en or /language id.', { lang: getLanguage() }))
            return
          }
          const wanted = parseLang(args)
          if (!wanted) {
            notice(t('Unknown language "{lang}". Use en or id.', { lang: args }), 'warn')
            return
          }
          setLanguage(wanted)
          try {
            writeGlobalConfig({ language: wanted }, runtime.env)
          } catch (error) {
            notice(t('Could not save the language: {error}', { error: (error as Error).message }), 'error')
          }
          notice(t('Language set to {lang} (saved as default).', { lang: wanted }))
          return
        }
        case 'login': {
          const id = runtime.modelRef.slice(0, runtime.modelRef.indexOf('/'))
          const key = await ask(t('API key for {provider}', { provider: runtime.providerLabel() }), true)
          if (!key) return
          const result = await runtime.addProviderKey(id, key)
          if (!result.ok) {
            notice(result.error, 'error')
            return
          }
          runtime.setModel(runtime.modelRef) // pick up the new key
          notice(t('Key for {provider} saved · {n} models.', { provider: runtime.providerLabel(), n: result.models }))
          return
        }
        case 'logout': {
          const id = runtime.modelRef.slice(0, runtime.modelRef.indexOf('/'))
          const removed = removeCredential(id, runtime.env)
          const envName = runtime.config.providers[id]?.apiKeyEnv
          if (envName && runtime.env[envName]) {
            notice(
              removed ? t('Stored key deleted, but {env} is still set in the environment and is still used.', { env: envName }) : t('No stored key; {env} is still set in the environment and is still used.', { env: envName }),
              'warn',
            )
            return
          }
          if (!removed) {
            notice(t('No stored key for {provider}.', { provider: runtime.providerLabel() }))
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
          notice(t('Key for {provider} deleted. Use /login or /provider to add one again.', { provider: runtime.providerLabel() }))
          return
        }
        case 'diff':
          notice(await gitDiff(runtime.cwd))
          return
        case 'worktree':
          notice(await worktreeListText(runtime.cwd))
          return
        case 'pr':
          void runTurn(prReviewPrompt(args))
          return
        case 'undo': {
          const result = await runtime.checkpoints.undo()
          if (!result) {
            notice(t('No file edits to undo.'))
            return
          }
          const rel = (p: string) => relative(runtime.cwd, p) || p
          notice(
            [
              result.failed.length ? t('Could not restore: {files}', { files: result.failed.map(rel).join(', ') }) : '',
              result.restored.length ? t('Restored: {files}', { files: result.restored.map(rel).join(', ') }) : '',
              result.deleted.length ? t('Deleted (new files): {files}', { files: result.deleted.map(rel).join(', ') }) : '',
              result.skipped.length ? t('Too large to back up, left unchanged: {files}', { files: result.skipped.map(rel).join(', ') }) : '',
              t('Note: changes made through bash commands cannot be undone.'),
            ]
              .filter(Boolean)
              .join('\n'),
          )
          return
        }
        case 'redo': {
          const result = await runtime.checkpoints.redo()
          if (!result) {
            notice(t('No file edits to redo.'))
            return
          }
          const rel = (p: string) => relative(runtime.cwd, p) || p
          notice(
            [
              result.failed.length ? t('Could not restore: {files}', { files: result.failed.map(rel).join(', ') }) : '',
              result.restored.length ? t('Re-applied: {files}', { files: result.restored.map(rel).join(', ') }) : '',
              result.deleted.length ? t('Deleted again: {files}', { files: result.deleted.map(rel).join(', ') }) : '',
              result.skipped.length ? t('Too large to back up, left unchanged: {files}', { files: result.skipped.map(rel).join(', ') }) : '',
            ]
              .filter(Boolean)
              .join('\n'),
          )
          return
        }
        case 'rewind': {
          const parsed = Number.parseInt(args.trim(), 10)
          const result = await runtime.rewindTurns(Number.isFinite(parsed) && parsed > 0 ? parsed : 1)
          if (!result) {
            notice(t('Nothing to rewind.'))
            return
          }
          setTranscript((tr) => {
            const userIndices: number[] = []
            tr.done.forEach((e, idx) => {
              if (e.kind === 'user') userIndices.push(idx)
            })
            const cutIdx = userIndices[Math.max(0, userIndices.length - result.turns)]
            return cutIdx !== undefined ? { done: tr.done.slice(0, cutIdx), live: [] } : tr
          })
          refreshStatic()
          const rel = (p: string) => relative(runtime.cwd, p) || p
          notice(
            [
              result.failed.length ? t('Could not restore: {files}', { files: result.failed.map(rel).join(', ') }) : '',
              result.restored.length ? t('Restored: {files}', { files: result.restored.map(rel).join(', ') }) : '',
              result.deleted.length ? t('Deleted (new files): {files}', { files: result.deleted.map(rel).join(', ') }) : '',
              result.skipped.length ? t('Too large to back up, left unchanged: {files}', { files: result.skipped.map(rel).join(', ') }) : '',
              t('Rewound {n} turn(s): the conversation continues from before them.', { n: result.turns }),
            ]
              .filter(Boolean)
              .join('\n'),
          )
          return
        }
        case 'copy': {
          const last = runtime.agent.messages.findLast((m) => m.role === 'assistant' && typeof m.content === 'string' && m.content.trim())
          if (!last || typeof last.content !== 'string') {
            notice(t('No answer to copy yet.'))
            return
          }
          process.stdout.write(osc52(last.content, !!process.env.TMUX))
          const file = join(runtime.home, 'last-answer.md')
          mkdirSync(runtime.home, { recursive: true })
          writeFileSync(file, last.content)
          notice(t('Copied to the clipboard (if the terminal supports OSC 52) and saved to {file}.', { file }))
          return
        }
        case 'export': {
          const name = args || `bccli-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.md`
          const file = resolve(runtime.cwd, name)
          if (existsSync(file)) {
            const answer = await ask(t('{file} already exists. Overwrite? (y/N)', { file }))
            if (!answer || !/^y(a|es)?$/i.test(answer.trim())) {
              notice(t('Export cancelled.'))
              return
            }
          }
          try {
            writeFileSync(file, exportMarkdown(runtime.agent.messages, t('BCCLI session {when}', { when: runtime.startedAt.toLocaleString(locale()) })))
          } catch (error) {
            notice(t('Could not write {file}: {error}', { file, error: (error as Error).message }), 'error')
            return
          }
          notice(t('Conversation saved to {file}.', { file }))
          return
        }
        case 'provider': {
          const c = runtime.config
          setProviderMenu(
            Object.keys(c.providers).map((id) => ({ id, name: providerName(c, id), ready: hasKey(c, id, runtime.env), baseURL: c.providers[id].baseURL })),
          )
          return
        }
        case 'config': {
          const c = runtime.config
          const applySetting = (key: string, val: string) => {
            if (key === 'theme') writeGlobalConfig({ theme: val }, runtime.env)
            else if (key === 'editor' && (val === 'emacs' || val === 'vim')) writeGlobalConfig({ editor: val }, runtime.env)
            else if (key === 'repoMap') writeGlobalConfig({ repoMap: val === 'true' || val === 'on' }, runtime.env)
            else if (key === 'thinkingVisible') {
              const next = val === 'true' || val === 'on'
              writeGlobalConfig({ thinkingVisible: next }, runtime.env)
              showThinkingRef.current = next
              setShowThinking(next)
              refreshStatic()
            } else if (key === 'thinkingClickCollapse') writeGlobalConfig({ thinkingClickCollapse: val === 'true' || val === 'on' }, runtime.env)
            else if (key === 'sandbox' && (val === 'on' || val === 'off')) writeGlobalConfig({ sandbox: val }, runtime.env)
            else if (key === 'networkPolicy' && (val === 'allow' || val === 'offline')) writeGlobalConfig({ networkPolicy: val }, runtime.env)
            else return false
            runtime.reloadConfig()
            setConfigRev((n) => n + 1)
            notice(`${key} = ${val}`)
            return true
          }
          if (args.trim()) {
            const [k, v] = args.trim().split(/\s+/)
            if (k && v && applySetting(k, v)) return
          }
          setListPicker({
            title: 'Config',
            items: [
              { id: `editor:${c.editor === 'vim' ? 'emacs' : 'vim'}`, label: `editor: ${c.editor}`, hint: 'toggle emacs/vim' },
              { id: `repoMap:${!c.repoMap}`, label: `repoMap: ${c.repoMap}`, hint: 'toggle true/false' },
              { id: `thinkingVisible:${!c.thinkingVisible}`, label: `thinkingVisible: ${!!c.thinkingVisible}`, hint: 'toggle true/false' },
              { id: `thinkingClickCollapse:${!c.thinkingClickCollapse}`, label: `thinkingClickCollapse: ${!!c.thinkingClickCollapse}`, hint: 'toggle true/false' },
              { id: `sandbox:${c.sandbox === 'on' ? 'off' : 'on'}`, label: `sandbox: ${c.sandbox}`, hint: 'toggle on/off' },
              { id: `networkPolicy:${c.networkPolicy === 'offline' ? 'allow' : 'offline'}`, label: `networkPolicy: ${c.networkPolicy ?? 'allow'}`, hint: 'toggle allow/offline' },
            ],
            onPick: (picked) => {
              setListPicker(null)
              if (!picked) return
              const [k, v] = picked.split(':')
              if (k && v) applySetting(k, v)
            },
          })
          return
        }
        default:
          notice(t('Unknown command: /{name}. Type /help.', { name }), 'warn')
      }
    },
    [runtime, notice, exit, version, runTurn, ask, refreshStatic, toggleThinking],
  )
  // A failing command (locked file, unwritable folder) must not take the whole app down.
  const runSlash = useCallback(
    (name: string, args: string) => runSlashCommand(name, args).catch((error: Error) => notice(`/${name}: ${error.message}`, 'error')),
    [runSlashCommand, notice],
  )

  const submit = useCallback(
    (text: string) => {
      setHistory((h) => [...h, text])
      if (text.startsWith('#') && text.slice(1).trim()) {
        void runSlash('memory', text.slice(1).trim())
        return
      }
      if (text.startsWith('!') && text.slice(1).trim()) {
        const cmd = text.slice(1).trim()
        setTranscript((tr) => ({ ...tr, done: [...tr.done, entry({ kind: 'user', text })] }))
        setBusy(true)
        setStartedAt(Date.now())
        const ctrl = new AbortController()
        controller.current = ctrl
        const shell = resolveShell({ platform: process.platform, env: runtime.env, exists: existsSync })
        void runCommand(cmd, { cwd: runtime.cwd, timeoutMs: 60_000, signal: ctrl.signal, shell })
          .then((r) => {
            const out = r.output.trim() || '(no output)'
            notice(`$ ${cmd}\n${out}`, r.exitCode ? 'error' : 'info')
            const ctxMsg = { role: 'user' as const, content: `Local shell command executed:\n$ ${cmd}\n${out}` }
            runtime.agent.messages.push(ctxMsg)
            runtime.session.append(ctxMsg)
          })
          .finally(() => {
            controller.current = null
            setBusy(false)
            setCancelling(false)
          })
        return
      }
      const slash = parseSlash(text)
      if (!slash) {
        void runTurn(text)
        return
      }
      // Built-ins win, then custom commands, then skills.
      // parseSlash lowercases the typed name, so match file names case-insensitively.
      const command = runtime.commands.find((c) => c.name.toLowerCase() === slash.name)
      const skill = runtime.skills.find((s) => s.name.toLowerCase() === slash.name)
      if (SLASH_COMMANDS.some((b) => b.name === slash.name) || slash.name === 't' || slash.name === 'output' || slash.name === 'o' || slash.name === 'quit' || (!command && !skill)) void runSlash(slash.name, slash.args)
      else if (command) void runTurn(expandCommand(command, slash.args))
      else if (skill) {
        let body: string
        try {
          body = parseFrontmatter(readFileSync(skill.file, 'utf8')).body
        } catch (error) {
          notice(t('Skill {name} cannot be read: {error}', { name: skill.name, error: (error as NodeJS.ErrnoException).code ?? (error as Error).message }), 'error')
          return
        }
        void runTurn(`${body}\n\nARGUMENTS: ${slash.args}`)
      }
    },
    [runSlash, runTurn, runtime, notice],
  )

  const onPrompt = useCallback(
    (text: string) => {
      if (!busy) {
        submit(text)
        return
      }
      // Menu, inspection, config, and toggle slash commands (plus #memory) have
      // nothing to do with queueing a new AI turn — execute them immediately!
      if (text.startsWith('#') && text.slice(1).trim()) {
        submit(text)
        return
      }
      const slash = parseSlash(text)
      if (slash) {
        const turnMutating = new Set(['init', 'pr', 'compact', 'rewind', 'undo', 'redo', 'resume'])
        const isCustomTurn =
          !SLASH_COMMANDS.some((b) => b.name === slash.name) &&
          slash.name !== 't' &&
          slash.name !== 'output' &&
          slash.name !== 'o' &&
          slash.name !== 'quit' &&
          (runtime.commands.some((c) => c.name.toLowerCase() === slash.name) || runtime.skills.some((s) => s.name.toLowerCase() === slash.name))
        if (!turnMutating.has(slash.name) && !isCustomTurn) {
          submit(text)
          return
        }
      }
      setQueued((q) => [...q, text])
    },
    [busy, submit, runtime],
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

  // Ensure real TTY starts with mouse tracking off (so native mouse wheel,
  // 2-finger touchpad scroll, and drag-to-copy work) and bracketed paste on.
  useEffect(() => {
    if (!isRealTty(stdout)) return
    stdout.write('\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?2004h')
    return () => {
      stdout.write('\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?2004l')
    }
  }, [stdout])

  // Ink has no mouse handler: enable SGR left-click reports while Thinking is
  // visible on screen. If the user scrolls with a 2-finger touchpad or mouse
  // wheel (\x1b[<64..67;x;yM), immediately suspend ?1000l so the terminal
  // scrolls its native scrollback buffer, then re-enable after scroll idle.
  useEffect(() => {
    const modalOpen = !!(pending || planAsk || picker || listPicker || mcpMenu || providerMenu || prompt)
    if (!runtime.config.thinkingClickCollapse || (!busy && !hasThinking) || modalOpen || !isTtyStream(stdin) || !isTtyStream(stdout)) return
    let click: { x: number; y: number } | undefined
    let mouseBuffer = ''
    let wheelTimer: ReturnType<typeof setTimeout> | undefined
    const onData = (data: Buffer | string) => {
      const chunk = String(data)
      if (hasMouseWheelSequence(chunk)) {
        stdout.write('\x1b[?1000l\x1b[?1006l')
        if (wheelTimer) clearTimeout(wheelTimer)
        wheelTimer = setTimeout(() => {
          stdout.write('\x1b[?1000h\x1b[?1006h')
        }, 1200)
      }
      // Windows ConPTY can split or combine the SGR mouse and cursor replies.
      // Keep an incomplete escape sequence across chunks and process both
      // reports when they arrive in the same chunk.
      mouseBuffer += chunk
      const reports = parseThinkingReports(mouseBuffer)
      mouseBuffer = reports.rest.slice(-80)
      for (const report of reports.events) {
        if (report.type === 'mouse') {
          click = report.press
          stdout.write('\x1b[6n')
        } else if (click && liveRootRef.current) {
          const current = click
          click = undefined
          const root = measureElement(liveRootRef.current)
          const candidates: DOMElement[] = []
          if (thinkingTargetRef.current) candidates.push(thinkingTargetRef.current)
          if (spinnerTargetRef.current) candidates.push(spinnerTargetRef.current)
          for (const el of thinkingEntryRefs.current.values()) {
            if (!candidates.includes(el)) candidates.push(el)
          }
          if (candidates.some((el) => clickedThinking(current, report.cursor.row, root.height, measureElement(el)))) {
            toggleThinking()
          }
        }
      }
    }
    stdin.on('data', onData)
    stdout.write('\x1b[?1000h\x1b[?1006h')
    return () => {
      if (wheelTimer) clearTimeout(wheelTimer)
      stdin.off('data', onData)
      stdout.write('\x1b[?1000l\x1b[?1006l')
    }
  }, [busy, hasThinking, pending, planAsk, picker, listPicker, mcpMenu, providerMenu, prompt, stdin, stdout, toggleThinking, runtime.config.thinkingClickCollapse])

  useInput((input, key) => {
    const modalOpen = !!(pending || planAsk || picker || listPicker || mcpMenu || providerMenu || prompt)
    if (key.tab && key.shift) {
      const next = nextMode(runtime.agent.permissions.mode)
      runtime.agent.permissions.mode = next
      setMode(next)
    } else if (key.escape && busy && !modalOpen) {
      controller.current?.abort()
      setCancelling(true)
      if (queued.length) {
        setQueued([])
        notice(t('{n} queued messages cancelled.', { n: queued.length }), 'warn')
      }
    } else if (matchKeybind(runtime.config.keybinds.pasteImage, input, key)) {
      void (async () => {
        const path = await grabClipboardImage({ platform: process.platform, tmpdir: tmpdir(), now: new Date() })
        if (path) {
          setInjected((prev) => ({ text: `${path} `, n: (prev?.n ?? 0) + 1 }))
          notice(t('Clipboard image saved to {path} — the path is inserted in the input; the model sees it when you send.', { path }))
        } else {
          notice(t('No image on the clipboard.'), 'warn')
        }
      })()
    } else if (matchKeybind(runtime.config.keybinds.thinking, input, key) || (key.meta && !key.ctrl && input.toLowerCase() === 't')) {
      toggleThinking()
    } else if (matchKeybind(runtime.config.keybinds.toolOutput, input, key) || (key.meta && !key.ctrl && input.toLowerCase() === 'o')) {
      setShowToolOutput((prev) => !prev)
      if (maxSplitIdxRef.current > 0) refreshStatic()
    } else if (key.ctrl && input.toLowerCase() === 'l') {
      refreshStatic()
    }
  })

  const pickMcp = async (name: string | undefined) => {
    const item = mcpMenu?.find((i) => i.name === name)
    setMcpMenu(null)
    if (!item) return
    if (item.installed) {
      removeGlobalServer(runtime.home, item.name)
      await runtime.mcp.remove(item.name)
      notice(t('MCP {name} removed.', { name: item.name }))
      return
    }
    const entry = CATALOG.find((c) => c.name === item.name)
    if (!entry) return
    const values: Record<string, string> = {}
    for (const input of entry.inputs ?? []) {
      const v = await ask(t(input.label), !!input.secret)
      if (!v) return
      values[input.key] = v
    }
    const config = fillTemplate(entry.config, values)
    addGlobalServer(runtime.home, entry.name, config)
    notice(t('MCP {name} installed, connecting…', { name: entry.name }))
    await runtime.mcp.add({ name: entry.name, config, source: 'global' })
    const state = runtime.mcp.states().find((s) => s.name === entry.name)
    if (state?.status === 'ready') notice(t('MCP {name} active · {n} tools.', { name: entry.name, n: state.tools }))
    else notice(t('MCP {name} failed: {error}', { name: entry.name, error: state?.error ?? t('unknown') }), 'error')
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
      const key = keyless ? '' : await ask(t('API key for {provider}', { provider: providerName(c, target) }), true)
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
    if (a === 'all') {
      for (const item of asks) item.resolve('all')
      setAsks([])
      setMode('allowAll')
      return
    }
    pending?.resolve(a)
    setAsks((q) => q.slice(1))
  }

  const capLive = (raw: string): string => capLiveMarkdown(raw, { isRealTty: realStdout, maxLines: maxLiveLines })

  const cwd = runtime.cwd.startsWith(homedir()) ? `~${runtime.cwd.slice(homedir().length)}` : runtime.cwd
  const renderEntry = (e: Entry) => {
    const isLive = transcript.live.some((le) => le.id === e.id)
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
      case 'assistant': {
        const displayText = isLive ? capLive(e.text) : e.text
        if (e.cont) {
          return displayText ? (
            <Box key={e.id} paddingLeft={2}>
              <Markdown text={displayText} />
            </Box>
          ) : null
        }
        if (!displayText.trim()) return null
        return (
          <Box key={e.id} marginTop={1}>
            <Text color={color(ACCENT)}>● </Text>
            <Markdown text={displayText.replace(/^\s+/, '')} />
          </Box>
        )
      }
      case 'thinking': {
        const text = e.text.trim()
        if (!text) return null
        const allLines = text.split('\n')
        const lines = allLines.length
        const shownText = isLive && realStdout && allLines.length > maxLiveLines
          ? `… (${allLines.length - maxLiveLines} lines above) …\n${allLines.slice(-maxLiveLines).join('\n')}`
          : text
        const isTarget = e.id === lastThinkingEntryId
        return (
          <Box
            key={e.id}
            ref={(el) => {
              if (isTarget) thinkingTargetRef.current = el
              if (el) thinkingEntryRefs.current.set(e.id, el)
              else thinkingEntryRefs.current.delete(e.id)
            }}
            marginTop={1}
            flexDirection="column"
          >
            <Box flexDirection="row">
              <Text dimColor>{showThinking ? t('✻ Thinking') : t('✻ Thinking · {n} lines', { n: lines })}</Text>
              <Text dimColor> · {runtime.config.keybinds.thinking.spec} / tab{runtime.config.thinkingClickCollapse ? ` · ${t('click to toggle')}` : ''}</Text>
            </Box>
            {showThinking ? (
              <Box flexDirection="column" paddingLeft={2}>
                <Text dimColor>{t('Model: {model} · reasoning: {level}', { model: runtime.modelRef, level: reasoning })}</Text>
                <Text dimColor italic>{shownText}</Text>
              </Box>
            ) : null}
          </Box>
        )
      }
      case 'tool':
        return (
          <ToolBlock key={e.id} tool={e.tool} target={e.target} output={e.output} display={e.display} isError={e.isError} done={e.done} expanded={showToolOutput} sub={e.sub} moreBind={runtime.config.keybinds.toolOutput.spec} />
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

  const activeToolEntry = transcript.live.findLast((e): e is Extract<Entry, { kind: 'tool' }> => e.kind === 'tool' && !e.done)
  const activeSub = activeToolEntry?.sub?.findLast((s) => !s.done)
  const activeTarget = (activeSub ? `${toolLabel(activeSub.tool)} ${activeSub.target}` : activeToolEntry?.target ?? '').replace(/\s+/g, ' ').trim()
  const activeSpinnerSummary = activeToolEntry
    ? `${toolLabel(activeToolEntry.tool)}${activeTarget ? ` ${activeTarget.length > 20 ? `${activeTarget.slice(0, 20)}…` : activeTarget}` : ''}`
    : ''
  const activeToolSummary = activeToolEntry
    ? `${toolLabel(activeToolEntry.tool)}${activeTarget ? ` ${activeTarget.length > 68 ? `${activeTarget.slice(0, 68)}…` : activeTarget}` : ''}`
    : ''

  return (
    <Box ref={liveRootRef} flexDirection="column">
      {/* Namespaced key: entry ids start at 0 too and are siblings of this element in the same
          Box, so a bare numeric `staticKey` collides with the header entry on early renders. */}
      <Static key={`static-${staticKey}`} items={staticDone}>{renderEntry}</Static>
      {activeTurnDone.map(renderEntry)}
      {transcript.live.map(renderEntry)}
      {busy && !pending && !planAsk ? (
        <Box
          ref={(el) => {
            spinnerTargetRef.current = el
            if (lastThinkingEntryId === undefined) thinkingTargetRef.current = el
          }}
          marginTop={1}
          flexDirection="column"
        >
          <Box flexDirection="row">
            <Spinner label={cancelling ? t('Cancelling') : activeSpinnerSummary ? `${t('Thinking')} · ${activeSpinnerSummary}` : t('Thinking')} startedAt={startedAt} />
            <Text dimColor> · {runtime.config.keybinds.thinking.spec} / tab{runtime.config.thinkingClickCollapse ? ` · ${t('click to toggle')}` : ''}</Text>
          </Box>
          {showThinking && lastThinkingEntryId === undefined ? (
            <Box flexDirection="column" paddingLeft={2}>
              <Text dimColor>{t('Model: {model} · reasoning: {level}', { model: runtime.modelRef, level: reasoning })}</Text>
              {activeToolSummary ? <Text dimColor>{`▶ ${activeToolSummary}`}</Text> : null}
              {!activeToolSummary ? (
                <Text dimColor>{t('No reasoning summary received yet; tool activity remains visible above.')}</Text>
              ) : null}
            </Box>
          ) : null}
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
        <Text key={`${i}-${q}`} dimColor>{t('  ⏳ queued: {q}', { q })}</Text>
      ))}
      <PromptInput disabled={!!pending || !!picker || !!providerMenu || !!prompt || !!planAsk || !!mcpMenu || !!listPicker} history={history} cwd={runtime.cwd} onSubmit={onPrompt} onEmptyTab={toggleThinking} extraCommands={extraCommands} injected={injected} vim={runtime.config.editor === 'vim'} />
      <StatusBar mode={mode} tokens={tokens} busy={busy} model={modelLabel} reasoning={reasoning} />
    </Box>
  )
}
