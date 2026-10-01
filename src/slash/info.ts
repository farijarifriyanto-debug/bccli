import { locale, t } from '../i18n'

const k = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n))

export interface StatusInput {
  version: string
  modelRef: string
  providerLabel: string
  mode: string
  cwd: string
  mcp: { name: string; status: string; error?: string; tools: number }[]
  usage: { inputTokens: number; outputTokens: number }
  lastInputTokens: number
}

export function statusText(s: StatusInput): string {
  const ready = s.mcp.filter((m) => m.status === 'ready').length
  const errors = s.mcp.filter((m) => m.status === 'error').length
  return [
    `BCCLI ${s.version}`,
    `Model: ${s.modelRef} (${s.providerLabel})`,
    t('Permission mode: {mode}', { mode: s.mode }),
    t('Folder: {cwd}', { cwd: s.cwd }),
    t('MCP: {ready} active, {errors} errors', { ready, errors }),
    t('Session tokens: {input} in · {output} out', { input: k(s.usage.inputTokens), output: k(s.usage.outputTokens) }),
    t('Context: ~{pct}% of 128k', { pct: Math.round((s.lastInputTokens / 128_000) * 100) }),
  ].join('\n')
}

export function agentsText(defs: { name: string; description: string; tools?: string[]; model?: string }[]): string {
  return defs.map((d) => t('{name} — {description} · tools: {tools} · model: {model}', { name: d.name, description: d.description, tools: d.tools ? d.tools.join(', ') : t('all'), model: d.model ?? t('same as main') })).join('\n')
}

export function skillsText(skills: { name: string; description: string; dir: string }[], commands: { name: string; description?: string }[]): string {
  const s = skills.length ? skills.map((x) => `${x.name} — ${x.description.slice(0, 80)} (${x.dir})`).join('\n') : t('(no skills)')
  const c = commands.length ? commands.map((x) => `/${x.name} — ${x.description ?? ''}`).join('\n') : t('(no custom commands)')
  return `${t('Skills')}:\n${s}\n\n${t('Custom commands')}:\n${c}`
}

export function sessionText(s: { file: string; started: Date; messages: number; usage: { inputTokens: number; outputTokens: number }; modelRef: string }): string {
  return [
    t('Started: {when}', { when: s.started.toLocaleString(locale()) }),
    t('{messages} messages · {input} tokens in · {output} out', { messages: s.messages, input: k(s.usage.inputTokens), output: k(s.usage.outputTokens) }),
    `Model: ${s.modelRef}`,
    t('File: {file}', { file: s.file }),
  ].join('\n')
}
