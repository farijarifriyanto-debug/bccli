import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { budgetStatus, priceFor } from '../src/budget'
import { ConfigError, loadConfig } from '../src/config'

const load = (global: object) => {
  const h = mkdtempSync(join(tmpdir(), 'bccli-b-'))
  writeFileSync(join(h, 'config.json'), JSON.stringify(global))
  return loadConfig(mkdtempSync(join(tmpdir(), 'bccli-bc-')), { BCCLI_HOME: h })
}

test('token cap blocks at or above the limit', () => {
  const cap = { tokens: 100 }
  expect(budgetStatus({ inputTokens: 40, outputTokens: 50 }, cap, 'x/y')).toBeUndefined()
  expect(budgetStatus({ inputTokens: 40, outputTokens: 60 }, cap, 'x/y')).toEqual({ kind: 'tokens', used: 100, limit: 100 })
})

test('usd cap uses the first price entry whose key is contained in the model ref', () => {
  const cap = { usd: 1, prices: { 'glm-5.3': { input: 2, output: 8 }, glm: { input: 100, output: 100 } } }
  expect(priceFor(cap, 'bc-cloud/glm-5.3-flash')).toEqual({ input: 2, output: 8 })
  // 400k in * 2 + 100k out * 8 per 1M = 0.8 + 0.8 = 1.6 usd >= 1
  expect(budgetStatus({ inputTokens: 400_000, outputTokens: 100_000 }, cap, 'bc-cloud/glm-5.3-flash')).toEqual({ kind: 'usd', used: 1.6, limit: 1 })
  expect(budgetStatus({ inputTokens: 10, outputTokens: 10 }, cap, 'bc-cloud/glm-5.3-flash')).toBeUndefined()
})

test('usd cap without a matching price never blocks; no cap never blocks', () => {
  const cap = { usd: 0.001, prices: { nomatch: { input: 9, output: 9 } } }
  expect(budgetStatus({ inputTokens: 1e9, outputTokens: 1e9 }, cap, 'bc-cloud/glm-5.3-flash')).toBeUndefined()
  expect(budgetStatus({ inputTokens: 1, outputTokens: 1 }, undefined, 'x')).toBeUndefined()
})

test('usageCap config: valid forms pass, junk fails fast', () => {
  expect(load({}).usageCap).toBeUndefined()
  expect(load({ usageCap: { tokens: 1000 } }).usageCap).toEqual({ tokens: 1000 })
  expect(load({ usageCap: { usd: 2, prices: { glm: { input: 1, output: 4 } } } }).usageCap).toEqual({ usd: 2, prices: { glm: { input: 1, output: 4 } } })
  expect(() => load({ usageCap: 'cheap' })).toThrow(ConfigError)
  expect(() => load({ usageCap: { tokens: 0 } })).toThrow(ConfigError)
  expect(() => load({ usageCap: { tokens: -5 } })).toThrow(ConfigError)
  expect(() => load({ usageCap: { usd: 1 } })).toThrow(ConfigError) // usd tanpa prices tidak bisa dihitung
  expect(() => load({ usageCap: { usd: 1, prices: { glm: { input: -1, output: 4 } } } })).toThrow(ConfigError)
  expect(() => load({ usageCap: {} })).toThrow(ConfigError) // kosong = tidak berguna
})
