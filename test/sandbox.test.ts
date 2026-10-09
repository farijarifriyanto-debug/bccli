import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { darwinProfile, sandboxArgv, sandboxSupported } from '../src/tools/sandbox'
import { createBashTool, runCommand } from '../src/tools/bash'
import { ConfigError, loadConfig } from '../src/config'
import type { ToolContext } from '../src/tools/types'

const ctx = (cwd = process.cwd()): ToolContext => ({ cwd, signal: new AbortController().signal, readFiles: new Set<string>() })

describe('sandbox', () => {
  it('supports darwin and linux only', () => {
    expect(sandboxSupported('darwin')).toBe(true)
    expect(sandboxSupported('linux')).toBe(true)
    expect(sandboxSupported('win32')).toBe(false)
  })

  it('darwin profile allows writes under cwd/tmp and gates the network', () => {
    const p = darwinProfile('/proj', false)
    expect(p).toContain('(version 1)')
    expect(p).toContain('(subpath "/proj")')
    expect(p).toContain('(deny network*)')
    expect(darwinProfile('/proj', true)).toContain('(allow network*)')
  })

  it('darwin argv uses sandbox-exec with the profile', () => {
    const argv = sandboxArgv('ls', { platform: 'darwin', cwd: '/proj', network: true })
    expect(argv?.[0]).toBe('sandbox-exec')
    expect(argv).toContain('-p')
    expect(argv?.slice(-3, -1)).toEqual(['/bin/bash', '-c'])
    expect(argv?.at(-1)).toBe('ls')
  })

  it('linux argv uses bwrap and unshares the network only when offline', () => {
    const off = sandboxArgv('ls', { platform: 'linux', cwd: '/proj', network: false })
    expect(off?.[0]).toBe('bwrap')
    expect(off).toContain('--unshare-net')
    expect(off).toContain('--ro-bind')
    expect(off).toContain('--bind')
    expect(off?.at(-1)).toBe('ls')
    const on = sandboxArgv('ls', { platform: 'linux', cwd: '/proj', network: true })
    expect(on).not.toContain('--unshare-net')
  })

  it('win32 has no argv', () => {
    expect(sandboxArgv('ls', { platform: 'win32', cwd: 'C:/x', network: true })).toBeUndefined()
  })

  it('runCommand accepts an argv array (no shell)', async () => {
    const r = await runCommand([process.execPath, '-e', 'console.log("SBX_ARGV_OK")'], {
      cwd: process.cwd(),
      timeoutMs: 15_000,
      signal: new AbortController().signal,
    })
    expect(r.output).toContain('SBX_ARGV_OK')
    expect(r.exitCode).toBe(0)
  })

  it('runCommand still accepts a shell string', async () => {
    const r = await runCommand(`${JSON.stringify(process.execPath)} -e "console.log('SBX_STR_OK')"`, {
      cwd: process.cwd(),
      timeoutMs: 15_000,
      signal: new AbortController().signal,
    })
    expect(r.output).toContain('SBX_STR_OK')
  })

  it('the bash tool refuses sandboxed runs on unsupported platforms', async () => {
    const tool = createBashTool({ sandbox: true, platform: 'win32' })
    const r = await tool.run({ command: 'echo hi' }, ctx())
    expect(r.isError).toBe(true)
    expect(r.output.toLowerCase()).toContain('sandbox')
  })

  it('the bash tool cannot write outside the sandbox even when bwrap is installed', async () => {
    if (process.platform !== 'linux') return
    const probe = mkdtempSync(join(homedir(), '.bccli-sandbox-test-'))
    const marker = join(probe, 'unsafe-write')
    try {
      const tool = createBashTool({ sandbox: true, platform: 'linux' })
      const r = await tool.run({ command: `printf UNWRAPPED > ${JSON.stringify(marker)}` }, ctx())
      // A sandboxed command is either blocked by bwrap startup or denied a write to HOME.
      // An unsafe raw-shell fallback would create the marker and fail this test.
      expect(existsSync(marker)).toBe(false)
      expect(r.isError).toBe(true)
    } finally {
      rmSync(probe, { recursive: true, force: true })
    }
  })

  it('config: sandbox must be "off" or "on", default off', () => {
    const project = mkdtempSync(join(tmpdir(), 'bccli-sbx-'))
    const home = mkdtempSync(join(tmpdir(), 'bccli-sbxh-'))
    writeFileSync(join(home, 'config.json'), '{}')
    expect(loadConfig(project, { BCCLI_HOME: home }).sandbox).toBe('off')
    writeFileSync(join(home, 'config.json'), JSON.stringify({ sandbox: 'maybe' }))
    expect(() => loadConfig(project, { BCCLI_HOME: home })).toThrow(ConfigError)
    writeFileSync(join(home, 'config.json'), JSON.stringify({ sandbox: 'on' }))
    expect(loadConfig(project, { BCCLI_HOME: home }).sandbox).toBe('on')
  })
})
