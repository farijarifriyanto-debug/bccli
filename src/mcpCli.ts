import type { CliArgs } from './args'
import { bccliHome } from './config'
import { CATALOG, fillTemplate } from './mcp/catalog'
import { addGlobalServer, globalMcpPath, readMcpFile, removeGlobalServer } from './mcp/config'
import type { CliDeps } from './providerCli'

export async function runMcpCommand(args: CliArgs, deps: CliDeps): Promise<number> {
  const home = bccliHome(deps.env)
  const [action = 'list', name] = args.subArgs
  const installed = readMcpFile(globalMcpPath(home))
  if (action === 'list') {
    for (const entry of CATALOG) deps.out(`${installed[entry.name] ? '✓' : '○'} ${entry.name.padEnd(12)} ${entry.description}`)
    for (const other of Object.keys(installed).filter((n) => !CATALOG.some((c) => c.name === n))) deps.out(`✓ ${other.padEnd(12)} (custom)`)
    return 0
  }
  if (!name) {
    deps.err(`Pemakaian: bccli mcp ${action} <nama>`)
    return 1
  }
  if (action === 'remove') {
    removeGlobalServer(home, name)
    deps.out(`${name} dihapus.`)
    return 0
  }
  if (action !== 'add') {
    deps.err(`Aksi tidak dikenal: ${action}. Pakai list, add, atau remove.`)
    return 1
  }
  if (args.url) {
    addGlobalServer(home, name, { type: 'http', url: args.url })
    deps.out(`${name} terpasang (${args.url}).`)
    return 0
  }
  const entry = CATALOG.find((c) => c.name === name)
  if (!entry) {
    deps.err(`${name} tidak ada di katalog. Untuk server remote lain pakai: bccli mcp add ${name} --url <url>`)
    return 1
  }
  const values = Object.fromEntries(args.values.map((v) => [v.slice(0, v.indexOf('=')), v.slice(v.indexOf('=') + 1)]))
  // Secrets are prompted (hidden) instead of passed on the command line.
  for (const input of entry.inputs ?? []) {
    if (!values[input.key] && input.secret) values[input.key] = await deps.readSecret(`${input.label}: `)
  }
  try {
    addGlobalServer(home, name, fillTemplate(entry.config, values))
  } catch (error) {
    const hint = (entry.inputs ?? [])
      .filter((i) => !i.secret)
      .map((i) => `--value ${i.key}=…`)
      .join(' ')
    deps.err(`${(error as Error).message}${hint ? `. Contoh: bccli mcp add ${name} ${hint}` : ''}`)
    return 1
  }
  deps.out(`${name} terpasang. Aktif di sesi bccli berikutnya.`)
  return 0
}
