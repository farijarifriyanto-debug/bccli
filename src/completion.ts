import type { CliArgs } from './args'
import { t } from './i18n'

export const SHELLS = ['bash', 'zsh', 'fish', 'powershell'] as const
export type CompletionShell = (typeof SHELLS)[number]

export function isCompletionShell(value: string): value is CompletionShell {
  return (SHELLS as readonly string[]).includes(value)
}

const COMMANDS = [
  'completion',
  'stats',
  'export',
  'import',
  'pr',
  'login',
  'models',
  'update',
  'acp',
  'serve',
  'plugins',
  'gh-bot',
  'provider',
  'mcp',
  'connect',
  'disconnect',
  'integrations',
]

const FLAGS = [
  '-p',
  '--print',
  '-m',
  '--model',
  '--reasoning',
  '-c',
  '--continue',
  '-r',
  '--resume',
  '--allow-all',
  '--allowed-tools',
  '-w',
  '--worktree',
  '--output-format',
  '--permission-mode',
  '--lang',
  '-v',
  '--version',
  '-h',
  '--help',
]

const WORDS = [...COMMANDS, ...FLAGS].join(' ')

function bashScript(): string {
  return `# bccli bash completion — add to your shell rc:
#   bccli completion bash > ~/.local/share/bash-completion/completions/bccli
_bccli_complete() {
  local cur
  cur="\${COMP_WORDS[COMP_CWORD]}"
  COMPREPLY=( $(compgen -W "${WORDS}" -- "$cur") )
}
complete -F _bccli_complete bccli
`
}

function zshScript(): string {
  return `# bccli zsh completion — add to your shell rc:
#   bccli completion zsh > "\${fpath[1]}/_bccli"
#compdef bccli
_bccli() {
  local -a words_list
  words_list=(${WORDS})
  _describe 'command' words_list
}
compdef _bccli bccli
`
}

function fishScript(): string {
  const lines = ['# bccli fish completion — add to your config:',
    '#   bccli completion fish > ~/.config/fish/completions/bccli.fish',
    `# flags: ${FLAGS.join(' ')}`]
  for (const w of COMMANDS) lines.push(`complete -c bccli -f -a '${w}'`)
  for (const f of FLAGS) lines.push(`complete -c bccli -l '${f.replace(/^-+/, '')}'`)
  return `${lines.join('\n')}\n`
}

function powershellScript(): string {
  return `# bccli powershell completion — add to your profile:
#   bccli completion powershell >> $PROFILE
Register-ArgumentCompleter -Native -CommandName bccli -ScriptBlock {
  param($wordToComplete, $commandAst, $cursorPosition)
  $words = '${WORDS}' -split ' '
  $words | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object {
    [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_)
  }
}
`
}

/** Completion script for a supported shell (bash, zsh, fish, powershell). */
export function completionScript(shell: CompletionShell): string {
  switch (shell) {
    case 'bash':
      return bashScript()
    case 'zsh':
      return zshScript()
    case 'fish':
      return fishScript()
    case 'powershell':
      return powershellScript()
  }
}

export interface CompletionDeps {
  out(line: string): void
  err?(line: string): void
}

/**
 * `bccli completion <bash|zsh|fish|powershell>` — print a completion script to stdout.
 */
export function runCompletionCommand(args: Pick<CliArgs, 'subArgs'>, deps: CompletionDeps): number {
  const shell = (args.subArgs[0] ?? '').trim()
  if (!shell || !isCompletionShell(shell)) {
    deps.err?.(t('usage: bccli completion <{shells}>', { shells: SHELLS.join(', ') }))
    return 1
  }
  for (const line of completionScript(shell).split('\n')) deps.out(line)
  return 0
}
