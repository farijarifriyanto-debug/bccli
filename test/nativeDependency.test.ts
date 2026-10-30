import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'

it('shipping the BCCLI native engine must not reintroduce Qwen runtime dependencies', () => {
  const pkg = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')) as {
    name: string
    version: string
    dependencies?: Record<string, string>
    optionalDependencies?: Record<string, string>
    bundledDependencies?: string[]
  }
  const lock = JSON.parse(readFileSync(resolve(process.cwd(), 'package-lock.json'), 'utf8')) as {
    packages: Record<string, unknown>
  }
  expect(pkg.name).toBe('@botconnector/bccli')
  expect(pkg.version).toBe('0.5.1')
  const deps = [
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.optionalDependencies ?? {}),
    ...(pkg.bundledDependencies ?? []),
    ...Object.keys(lock.packages ?? {}),
  ]
  expect(deps.filter((name) => name.includes('@qwen-code/'))).toEqual([])
})
