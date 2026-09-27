import { ConfigError } from '../config'
import type { McpServerConfig } from './config'

export interface CatalogInput {
  key: string
  label: string
  secret?: boolean
}
export interface CatalogEntry {
  name: string
  description: string
  config: McpServerConfig
  inputs?: CatalogInput[]
}

// Verified 2026-09-27 against npm/PyPI and the live endpoints. Postgres dropped: its npm package is deprecated.
export const CATALOG: CatalogEntry[] = [
  { name: 'playwright', description: 'kontrol browser (buka halaman, klik, isi form, screenshot)', config: { command: 'npx', args: ['-y', '@playwright/mcp@latest'] } },
  { name: 'context7', description: 'dokumentasi library terbaru', config: { type: 'http', url: 'https://mcp.context7.com/mcp' } },
  { name: 'fetch', description: 'ambil halaman web jadi markdown (butuh uv)', config: { command: 'uvx', args: ['mcp-server-fetch'] } },
  {
    name: 'filesystem',
    description: 'akses folder di luar project',
    config: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '${dir}'] },
    inputs: [{ key: 'dir', label: 'Folder yang boleh diakses' }],
  },
  { name: 'git', description: 'operasi git terstruktur (butuh uv)', config: { command: 'uvx', args: ['mcp-server-git'] } },
  {
    name: 'github',
    description: 'issue, PR, dan repo GitHub',
    config: { type: 'http', url: 'https://api.githubcopilot.com/mcp/', headers: { Authorization: 'Bearer ${token}' } },
    inputs: [{ key: 'token', label: 'GitHub Personal Access Token', secret: true }],
  },
]

export function fillTemplate(config: McpServerConfig, values: Record<string, string>): McpServerConfig {
  const missing = new Set<string>()
  const fill = (s: string) =>
    s.replace(/\$\{([A-Za-z0-9_]+)\}/g, (_m, key: string) => {
      if (!values[key]) missing.add(key)
      return values[key] ?? ''
    })
  const mapValues = (o: Record<string, string>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, fill(v)]))
  const out: McpServerConfig =
    config.type === 'http'
      ? { type: 'http', url: fill(config.url), ...(config.headers ? { headers: mapValues(config.headers) } : {}) }
      : {
          ...(config.type ? { type: config.type } : {}),
          command: fill(config.command),
          ...(config.args ? { args: config.args.map(fill) } : {}),
          ...(config.env ? { env: mapValues(config.env) } : {}),
        }
  if (missing.size) throw new ConfigError(`Isian MCP belum lengkap: ${[...missing].join(', ')}`)
  return out
}
