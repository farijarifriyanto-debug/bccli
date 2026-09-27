export interface DoctorDeps {
  which: (cmd: string) => boolean | Promise<boolean>
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
  const cmds = ['rg', 'git', 'npx', 'uvx']
  // Run the network check and the PATH lookups together so neither waits on the other.
  const [connection, found] = await Promise.all([
    deps.listModels().then(
      (models) => `✓ Koneksi ${input.activeProvider} (${models.length} model)`,
      (error: Error) => `✗ Koneksi ${input.activeProvider}: ${error.message}`,
    ),
    Promise.all(cmds.map(async (cmd) => deps.which(cmd))),
  ])
  lines.push(connection)
  for (const m of input.mcp) lines.push(m.status === 'error' ? `✗ MCP ${m.name}: ${m.error ?? ''}` : `✓ MCP ${m.name} (${m.status})`)
  for (const [i, cmd] of cmds.entries()) lines.push(`${found[i] ? '✓' : '✗'} ${cmd}`)
  return lines.join('\n')
}
