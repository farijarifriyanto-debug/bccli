import { t } from '../i18n'

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
  const lines = [major >= 22 ? `✓ Node ${deps.nodeVersion}` : t('✗ Node {version} (needs ≥ 22)', { version: deps.nodeVersion })]
  for (const p of input.providers) lines.push(p.ready ? `✓ ${p.name}` : t('○ {name} (no key yet)', { name: p.name }))
  const cmds = ['rg', 'git', 'npx', 'uvx']
  // Run the network check and the PATH lookups together so neither waits on the other.
  const [connection, found] = await Promise.all([
    deps.listModels().then(
      (models) => t('✓ Connection {provider} ({n} models)', { provider: input.activeProvider, n: models.length }),
      (error: Error) => t('✗ Connection {provider}: {error}', { provider: input.activeProvider, error: error.message }),
    ),
    Promise.all(cmds.map(async (cmd) => deps.which(cmd))),
  ])
  lines.push(connection)
  for (const m of input.mcp) lines.push(m.status === 'error' ? `✗ MCP ${m.name}: ${m.error ?? ''}` : `✓ MCP ${m.name} (${m.status})`)
  for (const [i, cmd] of cmds.entries()) lines.push(`${found[i] ? '✓' : '✗'} ${cmd}`)
  return lines.join('\n')
}
