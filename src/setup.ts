import { Agent } from './agent'
import type { CliArgs } from './args'
import { bccliHome, type Config, loadConfig, resolveModel } from './config'
import { buildSystemPrompt } from './context'
import { Permissions } from './permissions'
import { type ChatMessage, createProvider, type Provider } from './provider'
import { Session } from './session'
import { ALL_TOOLS } from './tools/index'

export interface Runtime {
  cwd: string
  home: string
  config: Config
  modelRef: string
  agent: Agent
  session: Session
  setModel(ref: string): void
}

const TOOL_RULES: Record<string, string> = { bash: 'bash', edit: 'edit', write: 'edit', fetch: 'fetch' }

export function createRuntime(opts: {
  cwd: string
  args: CliArgs
  env?: NodeJS.ProcessEnv
  provider?: Provider
  history?: ChatMessage[]
}): Runtime {
  const env = opts.env ?? process.env
  const home = bccliHome(env)
  const config = loadConfig(opts.cwd, env)
  let modelRef = opts.args.model ?? config.model
  const makeProvider = (ref: string) => {
    const resolved = resolveModel(config, ref, env)
    return opts.provider ?? createProvider({ baseURL: resolved.baseURL, apiKey: resolved.apiKey, model: resolved.model })
  }
  const provider = makeProvider(modelRef)
  const mode = opts.args.allowAll ? 'allowAll' : (opts.args.permissionMode ?? config.permissionMode)
  const rules = [...config.allow, ...opts.args.allowedTools.map((t) => TOOL_RULES[t] ?? t)]
  const permissions = new Permissions(mode, rules, opts.cwd)

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
    tools: ALL_TOOLS,
    permissions,
    systemPrompt: buildSystemPrompt({ cwd: opts.cwd, home, model: modelRef }),
    cwd: opts.cwd,
    history,
    onMessage: (m) => session.append(m),
    onReset: () => session.reset(),
  })

  return {
    cwd: opts.cwd,
    home,
    config,
    get modelRef() {
      return modelRef
    },
    agent,
    session,
    setModel(ref: string) {
      agent.provider = makeProvider(ref)
      modelRef = ref
    },
  }
}
