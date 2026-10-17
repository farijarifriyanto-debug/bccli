import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, vi } from 'vitest'
import { defaultOpen, FileOAuthProvider, openCommand } from '../src/mcp/oauth'

test('Windows: URL dibuka tanpa cmd.exe; seluruh URL tetap satu argumen', () => {
  const url = new URL('https://auth.example.com/authorize?client_id=a&scope=read%20write')
  const plan = openCommand(url, 'win32')
  expect(plan).toBeDefined()
  expect(plan?.command).not.toMatch(/cmd/i)
  // '&' must never reach a shell: it stays a byte inside one argv entry.
  expect(plan?.args).toEqual(['url.dll,FileProtocolHandler', url.href])
})

test('hanya http(s) yang boleh dibuka', () => {
  for (const bad of ['javascript:alert(1)', 'file:///C:/Windows/notepad.exe', 'ms-settings:about', 'vscode://x']) {
    expect(openCommand(new URL(bad), 'win32')).toBeUndefined()
  }
  expect(openCommand(new URL('http://127.0.0.1:5555/callback'), 'win32')).toBeDefined()
})

test('darwin/linux memakai open/xdg-open dengan URL sebagai argumen, bukan perintah shell', () => {
  const url = new URL('http://127.0.0.1:5555/callback?code=a&state=b')
  expect(openCommand(url, 'darwin')).toEqual({ command: 'open', args: [url.href] })
  expect(openCommand(url, 'linux')).toEqual({ command: 'xdg-open', args: [url.href] })
})

test('defaultOpen tidak men-spawn apa pun untuk scheme terlarang', () => {
  const spawned: unknown[][] = []
  const fake = ((...args: unknown[]) => {
    spawned.push(args)
    return { unref: () => {}, on: () => {} }
  }) as never
  defaultOpen(new URL('javascript:calc'), { platform: 'win32', spawn: fake })
  expect(spawned).toEqual([])
})

test('defaultOpen men-spawn tanpa shell dan tanpa cmd (argumen utuh)', () => {
  const spawned: unknown[][] = []
  const fake = ((...args: unknown[]) => {
    spawned.push(args)
    return { unref: () => {}, on: () => {} }
  }) as never
  const url = new URL('https://a.example/x?a=1&b=2|calc^%PATH%')
  defaultOpen(url, { platform: 'win32', spawn: fake })
  expect(spawned).toHaveLength(1)
  expect(spawned[0]?.[0]).toBe('rundll32.exe')
  expect(spawned[0]?.[1]).toEqual(['url.dll,FileProtocolHandler', url.href])
  expect(spawned[0]?.[2]).toMatchObject({ detached: true, stdio: 'ignore' })
})

test('mcp-oauth.json rusak: dipindahkan sekali, provider tetap bisa menyimpan token baru', () => {
  const home = mkdtempSync(join(tmpdir(), 'bccli-oauth-corrupt-'))
  writeFileSync(join(home, 'mcp-oauth.json'), '{broken')
  const warn = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    const provider = new FileOAuthProvider({ home, serverUrl: 'https://x.example/mcp' })
    expect(provider.tokens()).toBeUndefined()
    const backups = readdirSync(home).filter((f) => f.startsWith('mcp-oauth.json.corrupt-'))
    expect(backups).toHaveLength(1)
    expect(readFileSync(join(home, backups[0] as string), 'utf8')).toBe('{broken')
    provider.saveTokens({ access_token: 'at', token_type: 'Bearer' })
    expect(provider.tokens()?.access_token).toBe('at')
    expect(readdirSync(home).filter((f) => f.includes('.tmp'))).toEqual([])
  } finally {
    warn.mockRestore()
  }
})
