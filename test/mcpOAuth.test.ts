import { createServer, type Server } from 'node:http'
import { existsSync, mkdtempSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import {
  authorizeMcpServer,
  clearTokens,
  FileOAuthProvider,
  hasStoredTokens,
  parseCallback,
} from '../src/mcp/oauth'

function tmpHome(): string {
  return mkdtempSync(join(tmpdir(), 'bccli-oauth-'))
}

test('FileOAuthProvider round-trips tokens, client info and the code verifier in a 600 file', () => {
  const home = tmpHome()
  const provider = new FileOAuthProvider({ home, serverUrl: 'https://example.com/mcp' })
  expect(provider.tokens()).toBeUndefined()
  expect(provider.clientInformation()).toBeUndefined()
  provider.saveTokens({ access_token: 'at-1', refresh_token: 'rt-1', token_type: 'Bearer', expires_in: 3600 })
  provider.saveClientInformation({ client_id: 'cid-1' })
  provider.saveCodeVerifier('verifier-1')
  const store = join(home, 'mcp-oauth.json')
  expect(existsSync(store)).toBe(true)
  // Windows reports a permissive mode for files created with { mode }; POSIX honors 600.
  if (process.platform !== 'win32') expect(statSync(store).mode & 0o777).toBe(0o600)
  const second = new FileOAuthProvider({ home, serverUrl: 'https://example.com/mcp' })
  expect(second.tokens()?.access_token).toBe('at-1')
  expect(second.clientInformation()).toMatchObject({ client_id: 'cid-1' })
  expect(second.codeVerifier()).toBe('verifier-1')
})

test('invalidateCredentials clears only the requested scope', () => {
  const home = tmpHome()
  const provider = new FileOAuthProvider({ home, serverUrl: 'https://example.com/mcp' })
  provider.saveTokens({ access_token: 'at', token_type: 'Bearer' })
  provider.saveClientInformation({ client_id: 'cid' })
  provider.invalidateCredentials('tokens')
  expect(provider.tokens()).toBeUndefined()
  expect(provider.clientInformation()).toMatchObject({ client_id: 'cid' })
  provider.invalidateCredentials('all')
  expect(provider.clientInformation()).toBeUndefined()
})

test('client metadata declares a public PKCE client for BCCLI', () => {
  const provider = new FileOAuthProvider({
    home: tmpHome(),
    serverUrl: 'https://example.com/mcp',
    redirectUrl: 'http://127.0.0.1:5555/callback',
  })
  const meta = provider.clientMetadata
  expect(meta.client_name).toBe('BCCLI')
  expect(meta.token_endpoint_auth_method).toBe('none')
  expect(meta.grant_types).toContain('authorization_code')
  expect(String(meta.redirect_uris?.[0])).toBe('http://127.0.0.1:5555/callback')
})

test('parseCallback accepts code+state and rejects OAuth errors or gaps', () => {
  expect(parseCallback('http://127.0.0.1:1/callback?code=abc&state=s1')).toEqual({ code: 'abc', state: 's1' })
  expect(() => parseCallback('http://127.0.0.1:1/callback?error=access_denied&state=s1')).toThrow(/access_denied/)
  expect(() => parseCallback('http://127.0.0.1:1/callback?state=s1')).toThrow(/code/)
})

test('clearTokens removes stored tokens for one server only', () => {
  const home = tmpHome()
  new FileOAuthProvider({ home, serverUrl: 'https://a.example/mcp' }).saveTokens({ access_token: 'at-a', token_type: 'Bearer' })
  new FileOAuthProvider({ home, serverUrl: 'https://b.example/mcp' }).saveTokens({ access_token: 'at-b', token_type: 'Bearer' })
  expect(hasStoredTokens(home, 'https://a.example/mcp')).toBe(true)
  expect(clearTokens(home, 'https://a.example/mcp')).toBe(true)
  expect(hasStoredTokens(home, 'https://a.example/mcp')).toBe(false)
  expect(hasStoredTokens(home, 'https://b.example/mcp')).toBe(true)
  expect(clearTokens(home, 'https://a.example/mcp')).toBe(false)
})

interface FakeAuth {
  origin: string
  server: Server
  tokenRequests: URLSearchParams[]
  close(): Promise<void>
}

/** Minimal OAuth authorization server + MCP resource server for hermetic tests. */
function startFakeAuth(opts: { always401?: boolean } = {}): Promise<FakeAuth> {
  let origin = ''
  const tokenRequests: URLSearchParams[] = []
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', origin || 'http://127.0.0.1')
    const json = (body: unknown, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
      json({ resource: `${origin}/`, authorization_servers: [`${origin}/`] })
      return
    }
    if (url.pathname === '/.well-known/oauth-authorization-server') {
      json({
        issuer: `${origin}/`,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        registration_endpoint: `${origin}/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
      })
      return
    }
    if (url.pathname === '/register') {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => json({ client_id: 'fake-client', ...JSON.parse(body || '{}') }, 201))
      return
    }
    if (url.pathname === '/authorize') {
      const redirect = url.searchParams.get('redirect_uri') ?? '/'
      const state = url.searchParams.get('state') ?? ''
      res.writeHead(302, { location: `${redirect}?code=fake-code&state=${state}` })
      res.end()
      return
    }
    if (url.pathname === '/token') {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        tokenRequests.push(new URLSearchParams(body))
        json({ access_token: 'at-123', token_type: 'Bearer', refresh_token: 'rt-123', expires_in: 3600 })
      })
      return
    }
    if (url.pathname === '/mcp') {
      if (opts.always401 || req.headers.authorization !== 'Bearer at-123') {
        res.writeHead(401, {
          'www-authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
        })
        res.end()
        return
      }
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        let msg: { id?: number; method?: string; params?: { protocolVersion?: string } }
        try {
          msg = JSON.parse(body)
        } catch {
          res.writeHead(400)
          res.end()
          return
        }
        if (msg.id === undefined) {
          res.writeHead(202)
          res.end()
          return
        }
        if (msg.method === 'initialize') {
          res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'fake-session' })
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: msg.id,
              result: {
                protocolVersion: msg.params?.protocolVersion ?? '2025-03-26',
                capabilities: { tools: {} },
                serverInfo: { name: 'fake-mcp', version: '1.0' },
              },
            }),
          )
          return
        }
        if (msg.method === 'tools/list') {
          res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'fake-session' })
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: msg.id,
              result: { tools: [{ name: 'ping', description: 'Ping', inputSchema: { type: 'object', properties: {} } }] },
            }),
          )
          return
        }
        res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'fake-session' })
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }))
      })
      return
    }
    if (req.method === 'GET') {
      res.writeHead(405)
      res.end()
      return
    }
    res.writeHead(404)
    res.end()
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      origin = `http://127.0.0.1:${port}`
      resolve({
        origin,
        server,
        tokenRequests,
        close: () => new Promise<void>((done) => server.close(() => done())),
      })
    })
  })
}

test('authorizeMcpServer completes the PKCE flow and stores tokens (browser simulated)', async () => {
  const fake = await startFakeAuth()
  const home = tmpHome()
  try {
    let opened: URL | undefined
    await authorizeMcpServer(
      { name: 'e2e', config: { type: 'http', url: `${fake.origin}/mcp` } },
      {
        home,
        open: async (url) => {
          opened = new URL(url)
          // Simulate the browser: follow the authorize redirect back to our callback.
          const first = await fetch(opened, { redirect: 'manual' })
          const location = first.headers.get('location')
          if (location) await fetch(location)
        },
      },
    )
    expect(opened?.origin).toBe(fake.origin)
    expect(hasStoredTokens(home, `${fake.origin}/mcp`)).toBe(true)
    expect(fake.tokenRequests[0]?.get('code')).toBe('fake-code')
    expect(fake.tokenRequests[0]?.get('code_verifier')).toBeTruthy()
  } finally {
    await fake.close()
  }
})

test('authorizeMcpServer fails clearly when the user denies on the callback', async () => {
  const fake = await startFakeAuth()
  const home = tmpHome()
  try {
    await expect(
      authorizeMcpServer(
        { name: 'deny', config: { type: 'http', url: `${fake.origin}/mcp` } },
        {
          home,
          open: async (url) => {
            const authorize = new URL(url)
            const redirect = authorize.searchParams.get('redirect_uri') ?? ''
            const state = authorize.searchParams.get('state') ?? ''
            await fetch(`${redirect}?error=access_denied&state=${state}`)
          },
        },
      ),
    ).rejects.toThrow(/access_denied/)
  } finally {
    await fake.close()
  }
})

test('the manager shows the mcp auth hint when the server requires OAuth', async () => {
  const { McpManager } = await import('../src/mcp/manager')
  const fake = await startFakeAuth({ always401: true })
  const home = tmpHome()
  try {
    const opened: string[] = []
    const manager = new McpManager({ home, open: (url) => void opened.push(String(url)) })
    await manager.add({ name: 'needauth', config: { type: 'http', url: `${fake.origin}/mcp`, auth: 'oauth' }, source: 'global' })
    const state = manager.states()[0]
    expect(state?.status).toBe('error')
    expect(state?.error).toContain('mcp auth')
    expect(state?.error).toContain('needauth')
    expect(opened.length).toBeGreaterThan(0)
  } finally {
    await fake.close()
  }
})

test('the manager connects an http server with stored OAuth tokens', async () => {
  const { McpManager } = await import('../src/mcp/manager')
  const fake = await startFakeAuth()
  const home = tmpHome()
  try {
    await authorizeMcpServer(
      { name: 'e2e', config: { type: 'http', url: `${fake.origin}/mcp` } },
      {
        home,
        open: async (url) => {
          const first = await fetch(new URL(url), { redirect: 'manual' })
          const location = first.headers.get('location')
          if (location) await fetch(location)
        },
      },
    )
    const manager = new McpManager({ home })
    await manager.add({ name: 'e2e', config: { type: 'http', url: `${fake.origin}/mcp`, auth: 'oauth' }, source: 'global' })
    const state = manager.states()[0]
    expect(state?.status, state?.error).toBe('ready')
    expect(manager.tools().map((t) => t.name)).toContain('mcp__e2e__ping')
  } finally {
    await fake.close()
  }
})
