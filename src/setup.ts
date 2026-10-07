import { Agent } from './agent'
import { CheckpointStore } from './checkpoints'
import { BUILTIN_AGENTS } from './agents'
import { contextWindowFor } from './contextWindow'
import type { McpServerSpec } from './mcp/config'
import { McpManager } from './mcp/manager'
import type { CliArgs } from './args'
import { bccliHome, type Config, loadConfig, resolveModel } from './config'
import { homedir } from 'node:os'
import { buildSystemPrompt } from './context'
import { type AgentDef, type CommandDef, loadAgentDefs, loadCommands, loadSkills, type SkillDef } from './extensions'
import { Permissions } from './permissions'
import { listAllModels, type ModelGroup } from './models'
import { type ChatMessage, createProvider, type Provider } from './provider'
import type { ReasoningLevel } from './reasoning'
import { addProviderKey } from './providerCli'
import { providerName } from './providers'
import { Session } from './session'
import { ALL_TOOLS } from './tools/index'
import { createExitPlanTool, type Interaction } from './tools/plan'
import { createSkillTool } from './tools/skill'
import { createWebSearchTool } from './tools/websearch'
import { createTaskTool } from './tools/task'
import type { Tool } from './tools/types'
import { createTodoTool, TodoStore } from './tools/todo'
import { createSaveMemoryTool } from './tools/memory'
import { createRepoMapTool } from './tools/repomap'
import { createDiagnosticsTool } from './tools/diagnostics'
import { buildRepoMapSync } from './repomap'
import { createReadTool } from './tools/read'
import { createBashTool } from './tools/bash'
import { loadPlugins, type LoadedPlugins, type PluginPayload } from './plugins'
import type { HookEvent } from './hooks'

export interface Runtime {
  cwd: string
  home: string
  config: Config
  modelRef: string
  reasoning: ReasoningLevel
  agent: Agent
  session: Session
  setModel(ref: string): void
  setReasoning(level: ReasoningLevel): void
  env: NodeJS.ProcessEnv
  skills: SkillDef[]
  commands: CommandDef[]
  agentDefs: AgentDef[]
  todos: TodoStore
  interaction: Interaction
  mcp: McpManager
  startMcp(specs: McpServerSpec[]): Promise<void>
  reloadConfig(): void
  providerLabel(): string
  listModels: (only?: string) => Promise<ModelGroup[]>
  addProviderKey(id: string, key: string): ReturnType<typeof addProviderKey>
  /** Continue an earlier session: load its history and append new messages to its file. */
  resume(session: Session): void
  /** Starts a fresh session file; the previous one stays on disk for /resume. */
  newSession(): void
  /** Re-reads AGENTS.md/BCCLI.md into the system prompt (after /memory). */
  rebuildSystemPrompt(): void
  /** Fires a plugin observer event (SessionStart/Stop are emitted here; tool events come from the agent). */
  emitPlugins(event: HookEvent, payload?: PluginPayload): Promise<void>
  checkpoints: CheckpointStore
  /**
   * Steps back n conversation turns: truncates the history (and the session log) to before
   * them and restores the file snapshots they took. Returns undefined when nothing is left.
   */
  rewindTurns(n: number): Promise<RewindResult | undefined>
  startedAt: Date
}

export interface RewindResult {
  turns: number
  restored: string[]
  deleted: string[]
  skipped: string[]
  failed: string[]
}

const TOOL_RULES: Record<string, string> = { bash: 'bash', edit: 'edit', write: 'edit', fetch: 'fetch' }

/** PTC is automatic for Luna. This env var is only an emergency/internal kill switch. */
export function lunaPtcAutoEnabled(env: NodeJS.ProcessEnv): boolean {
  const value = String(env.BCCLI_LUNA_PTC ?? '').trim().toLowerCase()
  return !['0', 'false', 'off', 'no'].includes(value)
}

export function createRuntime(opts: {
  cwd: string
  args: CliArgs
  env?: NodeJS.ProcessEnv
  provider?: Provider
  history?: ChatMessage[]
  fetch?: typeof fetch
  userHome?: string
}): Runtime {
  const env = opts.env ?? process.env
  const home = bccliHome(env)
  let config = loadConfig(opts.cwd, env)
  let modelRef = opts.args.model ?? config.model
  let reasoning: ReasoningLevel = opts.args.reasoning ?? config.reasoning
  const makeProvider = (ref: string) => {
    const resolved = resolveModel(config, ref, env)
    return opts.provider ?? createProvider({
      baseURL: resolved.baseURL,
      apiKey: resolved.apiKey,
      model: resolved.model,
      providerId: resolved.providerId,
      enableProgrammaticToolCalling: lunaPtcAutoEnabled(env),
    })
  }
  const provider = makeProvider(modelRef)
  const mode = opts.args.allowAll ? 'allowAll' : (opts.args.permissionMode ?? config.permissionMode)
  const rules = [...config.allow, ...opts.args.allowedTools.map((t) => TOOL_RULES[t] ?? t)]
  const permissions = new Permissions(mode, rules, opts.cwd)
  const roots = { cwd: opts.cwd, home, userHome: opts.userHome ?? homedir() }
  const skills = loadSkills(roots)
  const commands = loadCommands(roots)
  const agentDefs = loadAgentDefs(roots)
  const todos = new TodoStore()
  const checkpoints = new CheckpointStore()
  // Conversation/file boundary of each main-agent turn: messages.length and checkpoints.entries()
  // captured at turn start, so /rewind can cut both back to the same point. Compaction invalidates
  // the newest message marks (they sit at the end); onTurnStart drops them before recording a new one.
  const turnMarks: number[] = []
  const checkpointMarks: number[] = []
  let startedAt = new Date()
  const interaction: Interaction = { approvePlan: async () => 'no' }

  let session = Session.create(home, opts.cwd)
  let history = opts.history
  if (!history && opts.args.continue) {
    const latest = Session.latest(home, opts.cwd)
    if (latest) {
      session = latest
      history = latest.load()
    }
  }

  const repoMap = config.repoMap ? buildRepoMapSync(opts.cwd) : undefined
  const systemFor = (model: string) => buildSystemPrompt({ cwd: opts.cwd, home, model, skills, repoMap })
  const systemPrompt = systemFor(modelRef)
  const webSearch = createWebSearchTool({
    botconnector: () => {
      try {
        const bc = resolveModel(config, 'bc-cloud/search', env)
        return bc.apiKey ? { baseURL: bc.baseURL, apiKey: bc.apiKey } : undefined
      } catch {
        return undefined
      }
    },
  })
  const rebuildPrompt = () => agent.setSystemPrompt(systemFor(modelRef))
  const saveMemory = createSaveMemoryTool({ home, onSaved: rebuildPrompt })
  const baseTools: Tool[] = [
    createReadTool({ vision: config.vision }),
    createBashTool({ networkPolicy: config.networkPolicy, sandbox: config.sandbox === 'on' }),
    ...ALL_TOOLS.filter((tool) => tool.name !== 'read' && tool.name !== 'bash'),
    webSearch,
    createSkillTool(skills),
    createTodoTool(todos),
    createExitPlanTool({ permissions, interaction }),
    saveMemory,
    createRepoMapTool(),
  ]
  if (config.lsp?.servers.length) baseTools.push(createDiagnosticsTool(config.lsp.servers))
  // Plugins are global-config only (project config never executes code); loaded at boot,
  // so a broken plugin fails fast and a fix needs a restart.
  const plugins: LoadedPlugins = loadPlugins(config.plugins ?? [], {
    home,
    cwd: opts.cwd,
    env,
    config,
    builtinNames: [...baseTools.map((tool) => tool.name), 'task'],
  })
  baseTools.push(...plugins.tools)
  const pluginEmit = (event: HookEvent, payload?: PluginPayload) => plugins.emit(event, payload)
  const task = createTaskTool({
    agents: [...BUILTIN_AGENTS, ...agentDefs],
    // Subagents get whatever the main agent has right now (incl. MCP tools), minus task itself.
    baseTools: () => agent.tools.filter((t) => t.name !== 'task'),
    permissions,
    provider: () => agent.provider,
    providerFor: makeProvider,
    systemPrompt: (childModelRef) => systemFor(childModelRef ?? modelRef),
    cwd: opts.cwd,
    reasoning: () => reasoning,
    hooks: config.hooks,
    pluginEmit,
    env,
  })
  const agent: Agent = new Agent({
    provider,
    tools: [...baseTools, task],
    permissions,
    systemPrompt,
    cwd: opts.cwd,
    history,
    reasoning,
    maxSteps: config.maxSteps,
    hooks: config.hooks,
    pluginEmit,
    env,
    usageCap: config.usageCap,
    budgetModel: modelRef,
    contextWindow: contextWindowFor(modelRef, env),
    onMessage: (m) => session.append(m),
    onReset: () => session.reset(),
    onTurnStart: () => {
      for (let i = turnMarks.length - 1; i >= 0 && turnMarks[i] > agent.messages.length; i--) {
        turnMarks.splice(i, 1)
        checkpointMarks.splice(i, 1)
      }
      turnMarks.push(agent.messages.length)
      checkpointMarks.push(checkpoints.entries())
      checkpoints.beginTurn()
    },
    checkpoint: (path) => checkpoints.snapshot(path),
  })

  // MCP tools join the agent's tool list whenever a server connects, fails or is removed.
  const mcp = new McpManager({
    home,
    onChange: () => agent.setTools([...baseTools, task, ...mcp.tools()]),
    // A later server may reuse a sanitized name; it must not inherit this one's "[a]" grants.
    onToolsRemoved: (names) => {
      for (const name of names) permissions.revoke(`mcp(${name})`)
    },
  })

  return {
    cwd: opts.cwd,
    home,
    env,
    skills,
    commands,
    agentDefs,
    todos,
    interaction,
    mcp,
    startMcp: (specs: McpServerSpec[]) => mcp.start(specs),
    get config() {
      return config
    },
    reloadConfig() {
      config = loadConfig(opts.cwd, env)
    },
    providerLabel() {
      return providerName(config, modelRef.slice(0, modelRef.indexOf('/')))
    },
    listModels: (only?: string) => listAllModels(config, env, { fetch: opts.fetch, only }),
    addProviderKey(id: string, key: string) {
      return addProviderKey(id, key, { env, cwd: opts.cwd, out: () => {}, err: () => {}, readSecret: async () => '', fetch: opts.fetch })
    },
    get modelRef() {
      return modelRef
    },
    get reasoning() {
      return reasoning
    },
    agent,
    get session() {
      return session
    },
    resume(previous: Session) {
      session = previous
      agent.load(previous.load())
      // Token counts and todos belonged to the conversation being left.
      agent.totalUsage = { inputTokens: 0, outputTokens: 0 }
      todos.set([])
      checkpoints.clear()
      turnMarks.length = 0
      checkpointMarks.length = 0
    },
    newSession() {
      session = Session.create(home, opts.cwd)
      agent.load([])
      agent.totalUsage = { inputTokens: 0, outputTokens: 0 }
      todos.set([])
      checkpoints.clear()
      turnMarks.length = 0
      checkpointMarks.length = 0
      startedAt = new Date()
    },
    rebuildSystemPrompt() {
      rebuildPrompt()
    },
    emitPlugins: (event, payload) => plugins.emit(event, payload),
    checkpoints,
    async rewindTurns(n: number) {
      if (turnMarks.length === 0) return undefined
      const count = Math.min(Math.max(1, Math.floor(n) || 1), turnMarks.length)
      const from = turnMarks.length - count
      const messageTarget = turnMarks[from]
      const checkpointTarget = checkpointMarks[from]
      turnMarks.splice(from)
      checkpointMarks.splice(from)
      const files = await checkpoints.undoTo(checkpointTarget)
      const kept = agent.messages.slice(0, Math.min(messageTarget, agent.messages.length))
      agent.load(kept)
      // The log is append-only: rewrite it as reset + the messages that survived the rewind.
      session.reset()
      for (const message of kept) session.append(message)
      return {
        turns: count,
        restored: files?.restored ?? [],
        deleted: files?.deleted ?? [],
        skipped: files?.skipped ?? [],
        failed: files?.failed ?? [],
      }
    },
    get startedAt() {
      return startedAt
    },
    setModel(ref: string) {
      const nextProvider = makeProvider(ref)
      modelRef = ref
      agent.provider = nextProvider
      agent.setContextWindow(contextWindowFor(ref, env))
      agent.setSystemPrompt(systemFor(modelRef))
    },
    setReasoning(level: ReasoningLevel) {
      reasoning = level
      agent.reasoning = level
    },
  }
}
