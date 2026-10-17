import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Session } from './session'
import { t } from './i18n'

export interface TransferCliArgs {
  subArgs: string[]
  home: string
  cwd: string
}

export interface TransferDeps {
  out(line: string): void
  err?(line: string): void
}

/**
 * `bccli export [file]` — copy the latest session in this folder to `file`
 * (or stdout when no file is given). Older sessions can be exported by
 * passing their absolute JSONL path as the first argument.
 */
export function runExportCommand(args: TransferCliArgs, deps: TransferDeps): number {
  const first = (args.subArgs[0] ?? '').trim()
  let source: string | undefined
  let dest: string | undefined
  if (first.endsWith('.jsonl') && existsSync(first) && statSync(first).isFile()) {
    source = first
    dest = args.subArgs[1]
  } else {
    const latest = Session.latest(args.home, args.cwd)
    if (!latest) {
      deps.err?.(t('no session to export in this folder'))
      return 1
    }
    source = latest.file
    dest = first || undefined
  }
  if (!dest) {
    for (const line of readFileSync(source, 'utf8').split('\n')) {
      if (line.trim()) deps.out(line)
    }
    return 0
  }
  mkdirSync(dirname(dest), { recursive: true })
  copyFileSync(source, dest)
  deps.out(t('exported {file}', { file: dest }))
  return 0
}

/**
 * `bccli import <file>` — copy a session JSONL into the current project.
 * Every line must parse as JSON before anything is written (atomic).
 */
export function runImportCommand(args: TransferCliArgs, deps: TransferDeps): number {
  const src = (args.subArgs[0] ?? '').trim()
  if (!src || !existsSync(src)) {
    deps.err?.(t('file not found: {file}', { file: src || '(none)' }))
    return 1
  }
  const raw = readFileSync(src, 'utf8')
  const lines = raw.split('\n').filter((l) => l.trim())
  for (const line of lines) {
    try {
      JSON.parse(line)
    } catch {
      deps.err?.(t('invalid session file (non-JSON line): {file}', { file: src }))
      return 1
    }
  }
  const slug =
    args.cwd
      .replace(/[^a-zA-Z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(-100) || 'root'
  const dir = join(args.home, 'sessions', slug)
  mkdirSync(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const dest = join(dir, `${stamp}-imported.jsonl`)
  writeFileSync(dest, lines.length ? `${lines.join('\n')}\n` : '')
  deps.out(t('imported {n} record(s) into {file}', { n: String(lines.length), file: dest }))
  return 0
}

/** Re-exported for tests that need the latest-session helper. */
export { readdirSync }
