import { expect, test } from 'vitest'
import { isManagedEntry, managedEntry, managedEntryName, parseNpmSpec } from '../src/pluginSpec'

test('Aturan 1: spec valid diterima', () => {
  expect(parseNpmSpec('foo')).toEqual({ name: 'foo', spec: 'foo' })
  expect(parseNpmSpec('@scope/bar')).toEqual({ name: '@scope/bar', spec: '@scope/bar' })
  expect(parseNpmSpec('foo@1.2.3')).toEqual({ name: 'foo', spec: 'foo@1.2.3' })
  expect(parseNpmSpec('foo@2.0.0-beta.1')).toEqual({ name: 'foo', spec: 'foo@2.0.0-beta.1' })
  expect(parseNpmSpec('foo@latest')).toEqual({ name: 'foo', spec: 'foo@latest' })
  expect(parseNpmSpec('@scope/bar@1.0.0')).toEqual({ name: '@scope/bar', spec: '@scope/bar@1.0.0' })
  expect(parseNpmSpec(' foo ')).toEqual({ name: 'foo', spec: 'foo' }) // trim ramah shell
})

test('Aturan 1: URL/git/path/flag/metachar/kapital/range ditolak', () => {
  for (const bad of [
    'https://evil.com/x.tgz',
    'git+ssh://git@host/r.git',
    'github:a/b',
    'file:./local',
    './local',
    '../up',
    '/abs/path',
    '-f',
    '--global',
    'foo;rm -rf',
    'foo bar',
    'FOO',
    '@scope',
    '@scope/',
    'foo@^1.2.0',
    'foo@~1',
    '',
  ]) {
    expect(parseNpmSpec(bad), bad).toBeNull()
  }
})

test('managedEntry / isManagedEntry', () => {
  expect(managedEntry('foo')).toBe('./plugins/node_modules/foo')
  expect(managedEntry('@scope/bar')).toBe('./plugins/node_modules/@scope/bar')
  expect(isManagedEntry('./plugins/node_modules/foo')).toBe(true)
  expect(isManagedEntry('./plugins/node_modules/@a/b')).toBe(true)
  expect(isManagedEntry('/abs/manual')).toBe(false)
  expect(isManagedEntry('./other/path')).toBe(false)
  expect(isManagedEntry('./plugins/node_modulesX/evil')).toBe(false) // prefix-presisi
})

test('managedEntryName: valid → nama polos; malformed → null (tabel traversal/flag/metachar/scope/versi)', () => {
  expect(managedEntryName('./plugins/node_modules/foo')).toBe('foo')
  expect(managedEntryName('./plugins/node_modules/@scope/bar')).toBe('@scope/bar')
  for (const bad of [
    './plugins/node_modules/../x', // traversal
    './plugins/node_modules/foo/../bar', // traversal internal
    './plugins/node_modules/-f', // flag
    './plugins/node_modules/--global',
    './plugins/node_modules/foo;rm', // metachar
    './plugins/node_modules/foo bar',
    './plugins/node_modules/foo@1.2.3', // sufiks versi di entry = malformed
    './plugins/node_modules/foo@latest', // sufiks tag
    './plugins/node_modules/FOO', // kapital
    './plugins/node_modules/@scope/bar@1.0.0',
    './plugins/node_modules/./x',
    './plugins/node_modules/',
  ]) {
    expect(managedEntryName(bad), bad).toBeNull()
  }
  expect(managedEntryName('/abs/manual')).toBeNull() // non-terelola → null (bukan malformed-terelola)
  expect(managedEntryName('./other/path')).toBeNull()
})
