import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createLspParser, createWarmLspClient, encodeLsp, getDiagnostics, languageIdFor, useShellForLsp } from '../src/lsp'
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
    expect(languageIdFor('a.ts')).toBe('typescript')
    expect(languageIdFor('App.tsx')).toBe('typescriptreact')
    expect(languageIdFor('main.py')).toBe('python')
    expect(languageIdFor('lib.rs')).toBe('rust')
    expect(useShellForLsp('typescript-language-server', 'win32')).toBe(true)
    expect(useShellForLsp('C:\\nodejs\\node.exe', 'win32')).toBe(false)
    expect(useShellForLsp('typescript-language-server', 'linux')).toBe(false)
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

  it('warm LSP client reuses a single process across diagnostics (didOpen -> didChange), hover, definition, and references', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bccli-lsp-warm-'))
    const file = join(root, 'a.ts')
    writeFileSync(file, 'const x = 1\n')
    const warm = createWarmLspClient({ server: SERVER, cwd: root })
    try {
      const d1 = await warm.diagnostics(file)
      expect(d1[0]?.message).toBe('fake problem')
      writeFileSync(file, 'const x = 2\n')
      const d2 = await warm.diagnostics(file)
      expect(d2[0]?.message).toBe('fake problem v2')

      const h1 = await warm.hover(file, 0, 6)
      const h2 = await warm.hover(file, 1, 2)
      expect(h1).toContain('hover-doc pid=')
      expect(h1).toContain('line=0')
      const pid1 = /pid=(\d+)/.exec(h1)?.[1]
      const pid2 = /pid=(\d+)/.exec(h2)?.[1]
      expect(pid1).toBeDefined()
      expect(pid1).toBe(pid2)

      const tool = createDiagnosticsTool([SERVER])
      const ctx: ToolContext = { cwd: root, signal: new AbortController().signal, readFiles: new Set<string>() }
      const hoverRes = await tool.run({ path: 'a.ts', action: 'hover', line: 3, character: 5 }, ctx)
      expect(hoverRes.output).toContain('hover-doc')
      expect(hoverRes.output).toContain('line=2')
      const defRes = await tool.run({ path: 'a.ts', action: 'definition', line: 1, character: 1 }, ctx)
      expect(defRes.output).toContain('a.ts:5:3')
      const refRes = await tool.run({ path: 'a.ts', action: 'references', line: 1, character: 1 }, ctx)
      expect(refRes.output).toContain('a.ts:10:1')
    } finally {
      await warm.close()
    }
  })
})
