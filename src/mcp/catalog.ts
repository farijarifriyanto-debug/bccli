import { ConfigError } from '../config'
import type { McpServerConfig } from './config'
import { t } from '../i18n'

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
  { name: 'playwright', description: 'control a browser (open pages, click, fill forms, screenshot)', config: { command: 'npx', args: ['-y', '@playwright/mcp@latest'] } },
  { name: 'context7', description: 'up-to-date library documentation', config: { type: 'http', url: 'https://mcp.context7.com/mcp' } },
  { name: 'fetch', description: 'fetch web pages as markdown (needs uv)', config: { command: 'uvx', args: ['mcp-server-fetch'] } },
  {
    name: 'filesystem',
    description: 'access folders outside the project',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: ${dir} is filled by fillTemplate, not a template literal
    config: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '${dir}'] },
    inputs: [{ key: 'dir', label: 'Folder the server may access' }],
  },
  { name: 'git', description: 'structured git operations (needs uv)', config: { command: 'uvx', args: ['mcp-server-git'] } },
  {
    name: 'github',
    description: 'GitHub issues, PRs, and repos',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: ${token} is filled by fillTemplate, not a template literal
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
  if (missing.size) throw new ConfigError(t('Missing MCP fields: {fields}', { fields: [...missing].join(', ') }))
  return out
}
