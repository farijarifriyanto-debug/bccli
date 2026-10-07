import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { color, currentTheme, setTheme, THEMES } from '../src/ui/theme'
import { ConfigError, loadConfig } from '../src/config'

describe('themes', () => {
  afterEach(() => {
    setTheme('default')
    delete process.env.NO_COLOR
  })

  it('lists the built-in themes', () => {
    expect(THEMES).toEqual(['default', 'blue', 'amber', 'magenta', 'mono'])
  })

  it('remaps colors per theme without touching call sites', () => {
    setTheme('blue')
    expect(currentTheme()).toBe('blue')
    expect(color('green')).toBe('blue')
    expect(color('gray')).toBe('gray')
    setTheme('amber')
    expect(color('green')).toBe('yellow')
    setTheme('magenta')
    expect(color('green')).toBe('magenta')
    setTheme('default')
    expect(color('green')).toBe('green')
  })

  it('mono drops every color', () => {
    setTheme('mono')
    expect(color('green')).toBeUndefined()
    expect(color('red')).toBeUndefined()
  })

  it('NO_COLOR still wins', () => {
    process.env.NO_COLOR = '1'
    setTheme('blue')
    expect(color('green')).toBeUndefined()
  })

  it('accepts a known theme from the global config', () => {
    const home = mkdtempSync(join(tmpdir(), 'bccli-theme-'))
    const project = mkdtempSync(join(tmpdir(), 'bccli-themep-'))
    writeFileSync(join(home, 'config.json'), JSON.stringify({ theme: 'blue' }))
    expect(loadConfig(project, { BCCLI_HOME: home }).theme).toBe('blue')
  })

  it('rejects unknown themes', () => {
    const home = mkdtempSync(join(tmpdir(), 'bccli-theme2-'))
    const project = mkdtempSync(join(tmpdir(), 'bccli-theme2p-'))
    writeFileSync(join(home, 'config.json'), JSON.stringify({ theme: 'rainbow' }))
    expect(() => loadConfig(project, { BCCLI_HOME: home })).toThrow(ConfigError)
  })

  it('defaults to the default theme', () => {
    const home = mkdtempSync(join(tmpdir(), 'bccli-theme3-'))
    const project = mkdtempSync(join(tmpdir(), 'bccli-theme3p-'))
    writeFileSync(join(home, 'config.json'), '{}')
    expect(loadConfig(project, { BCCLI_HOME: home }).theme).toBe('default')
  })
})
