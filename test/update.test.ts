import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { ConfigError, loadConfig } from '../src/config'
import { channelFor, checkForUpdate, compareVersions, dueForCheck, runUpdateCommand, updateNotice } from '../src/update'

test('compareVersions orders cores numerically and prereleases below releases', () => {
  expect(compareVersions('0.4.0-beta.38', '0.4.0-beta.39')).toBeLessThan(0)
  expect(compareVersions('0.4.0-beta.39', '0.4.0')).toBeLessThan(0)
  expect(compareVersions('0.4.0', '0.4.0')).toBe(0)
  expect(compareVersions('0.10.0', '0.9.9')).toBeGreaterThan(0)
  expect(compareVersions('1.0.0', '0.99.99')).toBeGreaterThan(0)
  expect(compareVersions('0.4.0-beta.3', '0.4.0-beta.10')).toBeLessThan(0)
})

test('channelFor: prerelease tracks next, release tracks latest', () => {
  expect(channelFor('0.4.0-beta.38')).toBe('next')
  expect(channelFor('0.4.0')).toBe('latest')
})

test('dueForCheck respects the 24h interval and missing cache', () => {
  const now = new Date('2026-10-07T12:00:00Z')
  expect(dueForCheck(undefined, now)).toBe(true)
  expect(dueForCheck({ checkedAt: '2026-10-06T00:00:00Z' }, now)).toBe(true) // 36 jam lalu
  expect(dueForCheck({ checkedAt: '2026-10-07T06:00:00Z' }, now)).toBe(false) // 6 jam lalu
  expect(dueForCheck({ checkedAt: 'bukan-tanggal' }, now)).toBe(true)
})

test('checkForUpdate writes the cache and returns a notice only when newer', async () => {
  const home = mkdtempSync(join(tmpdir(), 'bccli-upd-'))
  const fetchOk = (async () => new Response(JSON.stringify({ latest: '9.9.9', next: '9.9.9-beta.1' }))) as typeof fetch
  const notice = await checkForUpdate({ home, fetch: fetchOk, now: new Date() })
  // VERSION in tests is 0.0.0-dev â†’ channel "next"
  expect(notice).toContain('9.9.9-beta.1')
  expect(notice).toContain('bccli update')
  expect(existsSync(join(home, 'update-check.json'))).toBe(true)
  const cache = JSON.parse(readFileSync(join(home, 'update-check.json'), 'utf8'))
  expect(cache.latest).toBe('9.9.9-beta.1')
})

test('checkForUpdate reuses a fresh cache without fetching', async () => {
  const home = mkdtempSync(join(tmpdir(), 'bccli-upd3-'))
  const now = new Date('2026-10-07T12:00:00Z')
  const fetchOk = (async () => new Response(JSON.stringify({ latest: '9.9.9' }))) as typeof fetch
  await checkForUpdate({ home, fetch: fetchOk, now })
  let called = false
  const fetchSpy = (async () => {
    called = true
    return new Response('{}')
  }) as typeof fetch
  await checkForUpdate({ home, fetch: fetchSpy, now: new Date('2026-10-07T13:00:00Z') })
  expect(called).toBe(false)
})

test('checkForUpdate never throws on a dead registry', async () => {
  const home = mkdtempSync(join(tmpdir(), 'bccli-upd2-'))
  const fetchBad = (async () => {
    throw new Error('ECONNREFUSED')
  }) as typeof fetch
  expect(await checkForUpdate({ home, fetch: fetchBad, now: new Date() })).toBeUndefined()
})

test('updateNotice is undefined when not newer', () => {
  expect(updateNotice('9.9.9', '9.9.9')).toBeUndefined()
  expect(updateNotice('9.9.9', undefined)).toBeUndefined()
  expect(updateNotice('9.9.9', '0.1.0')).toBeUndefined()
})

test('runUpdateCommand installs from npm on the channel of the running version', async () => {
  const calls: { cmd: string; args: string[] }[] = []
  const fakeSpawn = ((cmd: string, args: string[]) => {
    calls.push({ cmd, args })
    return { status: 0 }
  }) as never
  expect(await runUpdateCommand({ env: { BCCLI_VERSION_OVERRIDE: '0.4.0-beta.38' }, spawn: fakeSpawn })).toBe(0)
  expect(calls[0]!.args).toContain('@botconnector/bccli@next')
  expect(await runUpdateCommand({ env: { BCCLI_VERSION_OVERRIDE: '0.4.0' }, spawn: fakeSpawn })).toBe(0)
  expect(calls[1]!.args).toContain('@botconnector/bccli@latest')
})

test('updateCheck config accepts "on"/"off" only, from the global config', () => {
  const load = (global: object) => {
    const h = mkdtempSync(join(tmpdir(), 'bccli-uc-'))
    writeFileSync(join(h, 'config.json'), JSON.stringify(global))
    return loadConfig(mkdtempSync(join(tmpdir(), 'bccli-ucc-')), { BCCLI_HOME: h })
  }
  expect(load({}).updateCheck).toBeUndefined()
  expect(load({ updateCheck: 'off' }).updateCheck).toBe('off')
  expect(load({ updateCheck: 'on' }).updateCheck).toBe('on')
  expect(() => load({ updateCheck: 'maybe' })).toThrow(ConfigError)
})
