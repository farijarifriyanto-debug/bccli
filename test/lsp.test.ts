import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createLspParser, encodeLsp, getDiagnostics } from '../src/lsp'
import { createDiagnosticsTool } from '../src/tools/diagnostics'
import { ConfigError, loadConfig } from '../src/config'
import type { ToolContext } from '../src/tools/types'

const FIXTURE = fileURLToPath(new URL('./fixtures/fake-lsp.mjs', import.meta.url))
const SERVER = { extensions: ['.ts'], command: process.execPath, args: [FIXTURE] }

describe('lsp framing', () => {
  it('round-trips a message through encode + parser', () => {
    const seen: unknown[] = []
    const parser = createLspParser((m) => seen.push(m))
    parser.push(encodeLsp({ jsonrpc: '2.0', id: 1, method: 'x', params: { a: 1 } }))
    expect(seen).toEqual([{ jsonrpc: '2.0', id: 1, method: 'x', params: { a: 1 } }])
  })

  it('handles a message split across chunks', () => {
    const seen: unknown[] = []
    const parser = createLspParser((m) => seen.push(m))
    const full = encodeLsp({ jsonrpc: '2.0', id: 2 })
    parser.push(full.subarray(0, 10))
    expect(seen).toEqual([])
    parser.push(full.subarray(10))
    expect(seen).toHaveLength(1)
  })
})

describe('lsp diagnostics', () => {
  it('collects publishDiagnostics from a real (fake) server', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bccli-lsp-'))
    const file = join(root, 'a.ts')
    writeFileSync(file, 'const x: number = "nope"\n')
    const diags = await getDiagnostics({ server: SERVER, cwd: root, file, timeoutMs: 15_000 })
    expect(diags).toEqual([{ line: 0, character: 0, severity: 1, message: 'fake problem' }])
  })

  it('resolves empty when the server never answers', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bccli-lsp2-'))
    const file = join(root, 'a.ts')
    writeFileSync(file, 'x')
    const diags = await getDiagnostics({
      server: { extensions: ['.ts'], command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'] },
      cwd: root,
      file,
      timeoutMs: 300,
    })
    expect(diags).toEqual([])
  })

  it('the diagnostics tool formats results and rejects unknown extensions', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bccli-lsp3-'))
    const file = join(root, 'a.ts')
    writeFileSync(file, 'const x = 1\n')
    const tool = createDiagnosticsTool([SERVER])
    expect(tool.name).toBe('diagnostics')
    const ctx: ToolContext = { cwd: root, signal: new AbortController().signal, readFiles: new Set<string>() }
    const ok = await tool.run({ path: 'a.ts' }, ctx)
    expect(ok.output).toContain('1:1')
    expect(ok.output).toContain('fake problem')
    expect(ok.isError).toBe(true) // severity 1 = error
    writeFileSync(join(root, 'b.txt'), 'hi')
    const bad = await tool.run({ path: 'b.txt' }, ctx)
    expect(bad.isError).toBe(true)
    expect(bad.output).toContain('.txt')
  })

  it('config: lsp must have a servers array of {extensions, command}', () => {
    const project = mkdtempSync(join(tmpdir(), 'bccli-lspcfg-'))
    const home = mkdtempSync(join(tmpdir(), 'bccli-lspcfgh-'))
    writeFileSync(join(home, 'config.json'), '{}')
    expect(loadConfig(project, { BCCLI_HOME: home }).lsp).toBeUndefined()
    writeFileSync(join(home, 'config.json'), JSON.stringify({ lsp: { servers: [{ command: 'x' }] } }))
    expect(() => loadConfig(project, { BCCLI_HOME: home })).toThrow(ConfigError)
    writeFileSync(
      join(home, 'config.json'),
      JSON.stringify({ lsp: { servers: [{ extensions: ['.ts'], command: 'typescript-language-server', args: ['--stdio'] }] } }),
    )
    const cfg = loadConfig(project, { BCCLI_HOME: home })
    expect(cfg.lsp?.servers).toHaveLength(1)
    expect(cfg.lsp?.servers[0].command).toBe('typescript-language-server')
  })
})
