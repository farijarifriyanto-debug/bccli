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
    `Mode izin: ${s.mode}`,
    `Folder: ${s.cwd}`,
    `MCP: ${ready} aktif, ${errors} error`,
    `Token sesi: ${k(s.usage.inputTokens)} masuk · ${k(s.usage.outputTokens)} keluar`,
    `Konteks: ±${Math.round((s.lastInputTokens / 128_000) * 100)}% dari 128k`,
  ].join('\n')
}

export function agentsText(defs: { name: string; description: string; tools?: string[]; model?: string }[]): string {
  return defs.map((d) => `${d.name} — ${d.description} · alat: ${d.tools ? d.tools.join(', ') : 'semua'} · model: ${d.model ?? 'ikut utama'}`).join('\n')
}

export function skillsText(skills: { name: string; description: string; dir: string }[], commands: { name: string; description?: string }[]): string {
  const s = skills.length ? skills.map((x) => `${x.name} — ${x.description.slice(0, 80)} (${x.dir})`).join('\n') : '(tidak ada skill)'
  const c = commands.length ? commands.map((x) => `/${x.name} — ${x.description ?? ''}`).join('\n') : '(tidak ada perintah custom)'
  return `Skill:\n${s}\n\nPerintah custom:\n${c}`
}

export function sessionText(s: { file: string; started: Date; messages: number; usage: { inputTokens: number; outputTokens: number }; modelRef: string }): string {
  return [
    `Mulai: ${s.started.toLocaleString('id-ID')}`,
    `${s.messages} pesan · ${k(s.usage.inputTokens)} token masuk · ${k(s.usage.outputTokens)} keluar`,
    `Model: ${s.modelRef}`,
    `File: ${s.file}`,
  ].join('\n')
}
