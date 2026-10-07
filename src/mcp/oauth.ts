import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { auth, type OAuthClientProvider, type OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js'
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js'
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { McpServerConfig } from './config'

export interface OAuthStorage {
  client?: OAuthClientInformationMixed
  tokens?: OAuthTokens
  codeVerifier?: string
  discovery?: OAuthDiscoveryState
}

export type OAuthStore = Record<string, OAuthStorage>

export const oauthStorePath = (home: string) => join(home, 'mcp-oauth.json')

function readStore(home: string): OAuthStore {
  const path = oauthStorePath(home)
  if (!existsSync(path)) return {}
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as OAuthStore
  } catch {
    return {}
  }
}

function writeStore(home: string, store: OAuthStore): void {
  const path = oauthStorePath(home)
  mkdirSync(dirname(path), { recursive: true })
  // Tokens are credentials: owner-only, same rule as trusted-mcp.json.
  writeFileSync(path, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 })
  chmodSync(path, 0o600)
}

export function hasStoredTokens(home: string, serverUrl: string): boolean {
  return Boolean(readStore(home)[serverUrl]?.tokens)
}

export function clearTokens(home: string, serverUrl: string): boolean {
  const store = readStore(home)
  const entry = store[serverUrl]
  if (!entry?.tokens && !entry?.client && !entry?.codeVerifier && !entry?.discovery) return false
  delete store[serverUrl]
  writeStore(home, store)
  return true
}

/** Opens a URL in the user's browser (best effort; callers should also print the URL). */
export function defaultOpen(url: URL): void {
  const target = url.href
  const child =
    process.platform === 'win32'
      ? spawn('cmd', ['/c', 'start', '', target], { detached: true, stdio: 'ignore' })
      : spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [target], { detached: true, stdio: 'ignore' })
  child.unref()
  child.on('error', () => {})
}

export interface FileOAuthProviderOptions {
  home: string
  serverUrl: string
  redirectUrl?: string | URL
  open?: (url: URL) => void | Promise<void>
}

/**
 * File-backed OAuthClientProvider: client registration, tokens, PKCE verifier and
 * discovery state per MCP server URL, stored in ~/.bccli/mcp-oauth.json (mode 600).
 */
export class FileOAuthProvider implements OAuthClientProvider {
  private readonly opts: FileOAuthProviderOptions

  constructor(opts: FileOAuthProviderOptions) {
    this.opts = opts
  }

  /**
   * Always defined: MCP SDK treats a missing redirectUrl as a non-interactive
   * (client_credentials) flow and would try a token exchange without a code.
   */
  get redirectUrl(): string | URL {
    return this.opts.redirectUrl ?? 'http://127.0.0.1:1/callback'
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'BCCLI',
      redirect_uris: [String(this.redirectUrl)],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }
  }

  private entry(): OAuthStorage {
    return readStore(this.opts.home)[this.opts.serverUrl] ?? {}
  }

  private patch(patch: OAuthStorage): void {
    const store = readStore(this.opts.home)
    const next = { ...store[this.opts.serverUrl], ...patch }
    for (const key of Object.keys(next) as (keyof OAuthStorage)[]) {
      if (next[key] === undefined) delete next[key]
    }
    store[this.opts.serverUrl] = next
    if (Object.keys(next).length === 0) delete store[this.opts.serverUrl]
    writeStore(this.opts.home, store)
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return this.entry().client
  }

  saveClientInformation(clientInformation: OAuthClientInformationMixed): void {
    this.patch({ client: clientInformation })
  }

  tokens(): OAuthTokens | undefined {
    return this.entry().tokens
  }

  saveTokens(tokens: OAuthTokens): void {
    this.patch({ tokens })
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.patch({ codeVerifier })
  }

  codeVerifier(): string {
    return this.entry().codeVerifier ?? ''
  }

  redirectToAuthorization(authorizationUrl: URL): void | Promise<void> {
    return (this.opts.open ?? defaultOpen)(authorizationUrl)
  }

  saveDiscoveryState(state: OAuthDiscoveryState): void {
    this.patch({ discovery: state })
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.entry().discovery
  }

  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): void {
    if (scope === 'all') {
      this.patch({ client: undefined, tokens: undefined, codeVerifier: undefined, discovery: undefined })
      return
    }
    if (scope === 'client') this.patch({ client: undefined })
    if (scope === 'tokens') this.patch({ tokens: undefined })
    if (scope === 'verifier') this.patch({ codeVerifier: undefined })
    if (scope === 'discovery') this.patch({ discovery: undefined })
  }
}

/** Parses the loopback callback URL; an OAuth error response throws. */
export function parseCallback(input: string | URL): { code: string; state?: string } {
  const url = typeof input === 'string' ? new URL(input) : input
  const error = url.searchParams.get('error')
  if (error) {
    const description = url.searchParams.get('error_description')
    throw new Error(description ? `OAuth ${error}: ${description}` : `OAuth ${error}`)
  }
  const code = url.searchParams.get('code')
  if (!code) throw new Error('OAuth callback is missing the code parameter.')
  const state = url.searchParams.get('state') ?? undefined
  return { code, state }
}

const CALLBACK_TIMEOUT_MS = 180_000

/**
 * Runs the MCP OAuth 2.1 (PKCE) flow for one http server: starts a loopback callback
 * server, hands the SDK auth() orchestrator the FileOAuthProvider, opens the browser,
 * waits for the code, exchanges it, and stores the tokens. Throws on deny/failure.
 */
export async function authorizeMcpServer(
  spec: { name: string; config: Extract<McpServerConfig, { type?: 'http' }> },
  deps: { home: string; open?: (url: URL) => void | Promise<void>; fetchFn?: FetchLike },
): Promise<void> {
  let settle: { resolve: (code: string) => void; reject: (error: Error) => void }
  const codeReceived = new Promise<string>((resolve, reject) => {
    settle = { resolve, reject }
  })
  // The browser (or a test double) can answer before we await; keep the rejection handled.
  codeReceived.catch(() => {})
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname !== '/callback') {
      res.writeHead(404)
      res.end()
      return
    }
    try {
      const { code } = parseCallback(url)
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<html><body><p>BCCLI is connected. You can close this tab.</p></body></html>')
      settle.resolve(code)
    } catch (error) {
      res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' })
      res.end(`<html><body><p>${(error as Error).message}</p></body></html>`)
      settle.reject(error as Error)
    }
  })
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve(typeof address === 'object' && address ? address.port : 0)
    })
  })
  try {
    const provider = new FileOAuthProvider({
      home: deps.home,
      serverUrl: spec.config.url,
      redirectUrl: `http://127.0.0.1:${port}/callback`,
      open: deps.open,
    })
    const serverUrl = new URL(spec.config.url)
    const result = await auth(provider, { serverUrl, fetchFn: deps.fetchFn })
    if (result === 'AUTHORIZED') return
    const timer = setTimeout(() => settle.reject(new Error('Timed out waiting for the OAuth callback.')), CALLBACK_TIMEOUT_MS)
    let code: string
    try {
      code = await codeReceived
    } finally {
      clearTimeout(timer)
    }
    const second = await auth(provider, { serverUrl, authorizationCode: code, fetchFn: deps.fetchFn })
    if (second !== 'AUTHORIZED') throw new Error('OAuth authorization did not complete.')
  } finally {
    server.close()
  }
}
