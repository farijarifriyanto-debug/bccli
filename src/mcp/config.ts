import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { ConfigError } from '../config'

export type McpServerConfig =
  | { type?: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }
  | { type: 'http'; url: string; headers?: Record<string, string> }

export interface McpServerSpec {
  name: string
  config: McpServerConfig
  source: 'global' | 'project'
}

export const globalMcpPath = (home: string) => join(home, 'mcp.json')
export const projectMcpPath = (cwd: string) => join(cwd, '.bccli', 'mcp.json')
const trustPath = (home: string) => join(home, 'trusted-mcp.json')

function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new ConfigError(`File MCP tidak valid: ${path} (${(error as Error).message})`)
  }
}

// Holds tokens (e.g. GitHub PAT), so owner-only.
function writePrivate(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 })
  chmodSync(path, 0o600)
}

export function readMcpFile(path: string): Record<string, McpServerConfig> {
  return readJson<{ mcpServers?: Record<string, McpServerConfig> }>(path, {}).mcpServers ?? {}
}

export function addGlobalServer(home: string, name: string, config: McpServerConfig): void {
  writePrivate(globalMcpPath(home), { mcpServers: { ...readMcpFile(globalMcpPath(home)), [name]: config } })
}

export function removeGlobalServer(home: string, name: string): void {
  const { [name]: _removed, ...rest } = readMcpFile(globalMcpPath(home))
  writePrivate(globalMcpPath(home), { mcpServers: rest })
}

type TrustFile = Record<string, Record<string, boolean>>

export function projectTrust(home: string, cwd: string, name: string): boolean | undefined {
  return readJson<TrustFile>(trustPath(home), {})[resolve(cwd)]?.[name]
}

export function setProjectTrust(home: string, cwd: string, name: string, allowed: boolean): void {
  const all = readJson<TrustFile>(trustPath(home), {})
  const key = resolve(cwd)
  writePrivate(trustPath(home), { ...all, [key]: { ...all[key], [name]: allowed } })
}

/** Global servers always; project servers only after a recorded yes. A project server never shadows a global one. */
export function serversToStart(home: string, cwd: string): { start: McpServerSpec[]; needTrust: McpServerSpec[] } {
  const global = readMcpFile(globalMcpPath(home))
  const start: McpServerSpec[] = Object.entries(global).map(([name, config]) => ({ name, config, source: 'global' }))
  const needTrust: McpServerSpec[] = []
  for (const [name, config] of Object.entries(readMcpFile(projectMcpPath(cwd)))) {
    if (global[name]) continue
    const trust = projectTrust(home, cwd, name)
    if (trust === true) start.push({ name, config, source: 'project' })
    else if (trust === undefined) needTrust.push({ name, config, source: 'project' })
  }
  return { start, needTrust }
}
