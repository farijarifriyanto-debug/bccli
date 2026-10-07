import { parseArgs } from 'node:util'
import { ConfigError, type PermissionMode } from './config'
import { MODE_ORDER } from './permissions'
import { isReasoningLevel, REASONING_LEVELS, type ReasoningLevel } from './reasoning'
import { type Lang, parseLang, t } from './i18n'

export interface CliArgs {
  command: 'run' | 'login' | 'models' | 'update' | 'acp' | 'provider' | 'mcp' | 'connect' | 'disconnect' | 'integrations'
  subArgs: string[]
  url?: string
  name?: string
  keyEnv?: string
  values: string[]
  prompt?: string
  print: boolean
  model?: string
  reasoning?: ReasoningLevel
  lang?: Lang
  continue: boolean
  resume: boolean
  allowAll: boolean
  allowedTools: string[]
  worktree?: string
  outputFormat?: 'text' | 'json' | 'stream-json'
  permissionMode?: PermissionMode
  help: boolean
  version: boolean
  loginProvider?: string
}

const HELP = `BCCLI — BotConnector's AI coding agent for the terminal

Usage:
  bccli [task]                  interactive mode (optionally start with a task)
  bccli -p "task"               run one task without interaction (scripts/CI)
  bccli login [provider]        save an API key (default: bc-cloud)
  bccli models [provider]       list models (default: the active provider)
  bccli update                  install the newest bccli from npm
  bccli acp                     run as an ACP agent for editors (Zed, ...)
  bccli provider list|add <id>|remove <id>   manage providers (custom: --url <url> [--name N] [--key-env ENV])
  bccli mcp list|add <name>|remove <name>|auth <name>|logout <name>    manage MCP servers (catalog, --url <url>, OAuth)
  bccli integrations             show the status of external agent integrations
  bccli connect <agent>          opencode, aider, cline, dsh, codex, claude-code, cursor, openai-cli, openai-sdk, openai-compatible, openclaw, hermes
  bccli disconnect <agent>       remove an integration and restore the previous config

Options:
  -m, --model <provider/model>  choose a model, e.g. bc-cloud/glm-5.3-flash
      --reasoning <level>        auto | off | low | medium | high | max
  -c, --continue                continue the last session in this folder
  -r, --resume                  pick a session to continue
      --allow-all               run all tools without asking for permission
      --allowed-tools <a,b>     tools allowed without asking: bash, edit, fetch
  -w, --worktree <name>        run in git worktree ../<repo>.worktrees/<name> (created, or reused if it exists)
      --output-format <fmt>     text | json | stream-json for -p (machine-readable output)
      --permission-mode <mode>  default | acceptEdits | plan | allowAll
      --lang <en|id>            interface language (default: en; or BCCLI_LANG, or "language" in config)
  -v, --version                 version
  -h, --help                    this help`

/** Help text in the current language (call it after the language is set). */
export const helpText = (): string => t(HELP)

export function parseCliArgs(argv: string[]): CliArgs {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      print: { type: 'boolean', short: 'p' },
      model: { type: 'string', short: 'm' },
      reasoning: { type: 'string' },
      lang: { type: 'string' },
      continue: { type: 'boolean', short: 'c' },
      resume: { type: 'boolean', short: 'r' },
      'allow-all': { type: 'boolean' },
      'allowed-tools': { type: 'string' },
      worktree: { type: 'string', short: 'w' },
      'output-format': { type: 'string' },
      'permission-mode': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
      url: { type: 'string' },
      name: { type: 'string' },
      'key-env': { type: 'string' },
      value: { type: 'string', multiple: true },
    },
  })
  const reasoning = values.reasoning
  if (reasoning && !isReasoningLevel(reasoning)) {
    throw new ConfigError(t('--reasoning must be one of: {levels}', { levels: REASONING_LEVELS.join(', ') }))
  }
  const mode = values['permission-mode']
  if (mode && !MODE_ORDER.includes(mode as PermissionMode)) {
    throw new ConfigError(t('--permission-mode must be one of: {modes}', { modes: MODE_ORDER.join(', ') }))
  }
  if (values.lang !== undefined && !parseLang(values.lang)) throw new ConfigError(t('--lang must be one of: en, id'))
  const outputFormat = values['output-format']
  if (outputFormat !== undefined && !['text', 'json', 'stream-json'].includes(outputFormat)) {
    throw new ConfigError(t('--output-format must be one of: {formats}', { formats: 'text, json, stream-json' }))
  }
  const [first, ...rest] = positionals
  const SUBCOMMANDS = ['login', 'models', 'update', 'acp', 'provider', 'mcp', 'connect', 'disconnect', 'integrations']
  const command = SUBCOMMANDS.includes(first) ? (first as CliArgs['command']) : 'run'
  const words = command === 'run' ? positionals : rest
  return {
    command,
    prompt: command === 'run' && words.length ? words.join(' ') : undefined,
    print: !!values.print,
    model: values.model,
    reasoning: reasoning as ReasoningLevel | undefined,
    lang: parseLang(values.lang),
    continue: !!values.continue,
    resume: !!values.resume,
    allowAll: !!values['allow-all'],
    allowedTools: (values['allowed-tools'] ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    worktree: values.worktree,
    outputFormat: outputFormat as CliArgs['outputFormat'],
    permissionMode: mode as PermissionMode | undefined,
    help: !!values.help,
    version: !!values.version,
    loginProvider: command === 'login' ? (rest[0] ?? 'bc-cloud') : undefined,
    subArgs: ['models', 'provider', 'mcp', 'connect', 'disconnect', 'integrations'].includes(command) ? rest : [],
    url: values.url,
    name: values.name,
    keyEnv: values['key-env'],
    values: values.value ?? [],
  }
}
