import { Agent } from './agent'
import type { CliArgs } from './args'
import { bccliHome, type Config, loadConfig, resolveModel } from './config'
import { homedir } from 'node:os'
import { buildSystemPrompt } from './context'
import { type AgentDef, type CommandDef, loadAgentDefs, loadCommands, loadSkills, type SkillDef } from './extensions'
import { Permissions } from './permissions'
import { listAllModels, type ModelGroup } from './models'
import { type ChatMessage, createProvider, type Provider } from './provider'
import { addProviderKey } from './providerCli'
import { providerName } from './providers'
import { Session } from './session'
import { ALL_TOOLS } from './tools/index'
import { createSkillTool } from './tools/skill'
import { createTodoTool, TodoStore } from './tools/todo'

export interface Runtime {
  cwd: string
  home: string
  config: Config
  modelRef: string
  agent: Agent
  session: Session
  setModel(ref: string): void
  env: NodeJS.ProcessEnv
  skills: SkillDef[]
  commands: CommandDef[]
  agentDefs: AgentDef[]
  todos: TodoStore
  reloadConfig(): void
  providerLabel(): string
  listModels: (only?: string) => Promise<ModelGroup[]>
  addProviderKey(id: string, key: string): ReturnType<typeof addProviderKey>
  /** Continue an earlier session: load its history and append new messages to its file. */
  resume(session: Session): void
}

const TOOL_RULES: Record<string, string> = { bash: 'bash', edit: 'edit', write: 'edit', fetch: 'fetch' }

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
  const makeProvider = (ref: string) => {
    const resolved = resolveModel(config, ref, env)
    return opts.provider ?? createProvider({ baseURL: resolved.baseURL, apiKey: resolved.apiKey, model: resolved.model })
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

  let session = Session.create(home, opts.cwd)
  let history = opts.history
  if (!history && opts.args.continue) {
    const latest = Session.latest(home, opts.cwd)
    if (latest) {
      session = latest
      history = latest.load()
    }
  }

  const agent = new Agent({
    provider,
    tools: [...ALL_TOOLS, createSkillTool(skills), createTodoTool(todos)],
    permissions,
    systemPrompt: buildSystemPrompt({ cwd: opts.cwd, home, model: modelRef, skills }),
    cwd: opts.cwd,
    history,
    onMessage: (m) => session.append(m),
    onReset: () => session.reset(),
  })

  return {
    cwd: opts.cwd,
    home,
    env,
    skills,
    commands,
    agentDefs,
    todos,
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
    agent,
    get session() {
      return session
    },
    resume(previous: Session) {
      session = previous
      agent.messages = previous.load()
    },
    setModel(ref: string) {
      agent.provider = makeProvider(ref)
      modelRef = ref
    },
  }
}
