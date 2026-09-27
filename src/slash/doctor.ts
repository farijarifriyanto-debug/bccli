export interface DoctorDeps {
  which: (cmd: string) => boolean
  nodeVersion: string
  listModels: () => Promise<unknown[]>
}

export async function doctorText(
  input: { providers: { id: string; name: string; ready: boolean }[]; mcp: { name: string; status: string; error?: string }[]; activeProvider: string },
  deps: DoctorDeps,
): Promise<string> {
  const major = Number(deps.nodeVersion.replace(/^v/, '').split('.')[0])
  const lines = [major >= 22 ? `✓ Node ${deps.nodeVersion}` : `✗ Node ${deps.nodeVersion} (butuh ≥ 22)`]
  for (const p of input.providers) lines.push(p.ready ? `✓ ${p.name}` : `○ ${p.name} (belum ada key)`)
  try {
    lines.push(`✓ Koneksi ${input.activeProvider} (${(await deps.listModels()).length} model)`)
  } catch (error) {
    lines.push(`✗ Koneksi ${input.activeProvider}: ${(error as Error).message}`)
  }
  for (const m of input.mcp) lines.push(m.status === 'error' ? `✗ MCP ${m.name}: ${m.error ?? ''}` : `✓ MCP ${m.name} (${m.status})`)
  for (const cmd of ['rg', 'git', 'npx', 'uvx']) lines.push(`${deps.which(cmd) ? '✓' : '✗'} ${cmd}`)
  return lines.join('\n')
}
