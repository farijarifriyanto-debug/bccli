import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { ConfigError, loadConfig } from '../src/config'
import { DEFAULT_KEYBINDS, matchKeybind, parseKeybind } from '../src/keybinds'

const home = () => mkdtempSync(join(tmpdir(), 'bccli-kb-'))
const cwd = () => mkdtempSync(join(tmpdir(), 'bccli-kbc-'))
const load = (global: object, project?: object) => {
  const h = home()
  const c = cwd()
  writeFileSync(join(h, 'config.json'), JSON.stringify(global))
  if (project) {
    const { mkdirSync } = require('node:fs') as typeof import('node:fs')
    mkdirSync(join(c, '.bccli'), { recursive: true })
    writeFileSync(join(c, '.bccli', 'config.json'), JSON.stringify(project))
  }
  return loadConfig(c, { BCCLI_HOME: h })
}

test('defaults keep ctrl+t for thinking and ctrl+o for tool output', () => {
  const config = load({})
  expect(config.keybinds.thinking.spec).toBe('ctrl+t')
  expect(config.keybinds.toolOutput.spec).toBe('ctrl+o')
  expect(config.keybinds.pasteImage.spec).toBe('alt+v')
  expect(DEFAULT_KEYBINDS.thinking).toBe('ctrl+t')
})

test('a custom global binding is parsed and kept verbatim for display', () => {
  const config = load({ keybinds: { thinking: 'alt+x', toolOutput: 'ctrl+alt+o' } })
  expect(config.keybinds.thinking).toEqual({ spec: 'alt+x', ctrl: false, meta: true, key: 'x' })
  expect(config.keybinds.toolOutput).toMatchObject({ spec: 'ctrl+alt+o', ctrl: true, meta: true, key: 'o' })
})

test('keybinds are global-config only: a project config cannot rebind keys', () => {
  const config = load({}, { keybinds: { thinking: 'alt+q' } })
  expect(config.keybinds.thinking.spec).toBe('ctrl+t')
})

test('invalid keybind configs fail fast with a clear error', () => {
  expect(() => load({ keybinds: { thinking: 't' } })).toThrow(ConfigError) // a bare letter would fire while typing
  expect(() => load({ keybinds: { thinking: 'ctrl+xy' } })).toThrow(/ctrl\+xy/)
  expect(() => load({ keybinds: { thinking: 'ctrl+' } })).toThrow(ConfigError)
  expect(() => load({ keybinds: { thinking: 42 } })).toThrow(ConfigError)
  expect(() => load({ keybinds: { nope: 'ctrl+x' } })).toThrow(/nope/) // unknown action names the offender in both languages
  expect(() => load({ keybinds: [] })).toThrow(ConfigError)
})

test('parseKeybind normalizes case and rejects junk', () => {
  expect(parseKeybind('CTRL+T')).toEqual({ spec: 'ctrl+t', ctrl: true, meta: false, key: 't' })
  expect(parseKeybind('')).toBeUndefined()
  expect(parseKeybind('shift+a')).toBeUndefined()
  expect(parseKeybind('ctrl+t+x')).toBeUndefined()
})

test('matchKeybind matches only the exact modifier combination', () => {
  const kb = parseKeybind('ctrl+t')!
  expect(matchKeybind(kb, 't', { ctrl: true })).toBe(true)
  expect(matchKeybind(kb, 'T', { ctrl: true })).toBe(true)
  expect(matchKeybind(kb, 't', { ctrl: true, meta: true })).toBe(false)
  expect(matchKeybind(kb, 't', {})).toBe(false)
  expect(matchKeybind(kb, 'x', { ctrl: true })).toBe(false)
  const alt = parseKeybind('alt+x')!
  expect(matchKeybind(alt, 'x', { meta: true })).toBe(true)
  expect(matchKeybind(alt, 'X', { meta: true })).toBe(true) // shift on a letter arrives as uppercase; it must not break alt binds
  expect(matchKeybind(alt, 'x', { ctrl: true })).toBe(false)
})
