import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, vi } from 'vitest'
import { readCredentials, removeCredential, saveCredential } from '../src/config'

const env = () => ({ BCCLI_HOME: mkdtempSync(join(tmpdir(), 'bccli-creds-')) } as NodeJS.ProcessEnv)
const home = (e: NodeJS.ProcessEnv) => e.BCCLI_HOME as string
const credsPath = (e: NodeJS.ProcessEnv) => join(home(e), 'credentials')
const leftovers = (e: NodeJS.ProcessEnv) => readdirSync(home(e)).filter((f) => f.includes('.tmp'))

test('saveCredential/removeCredential: penulisan atomik, key lain dipertahankan, tanpa sisa .tmp', () => {
  const e = env()
  saveCredential('a', 'k1', e)
  saveCredential('b', 'k2', e)
  expect(readCredentials(e)).toEqual({ a: 'k1', b: 'k2' })
  expect(leftovers(e)).toEqual([])
  if (process.platform !== 'win32') expect(statSync(credsPath(e)).mode & 0o777).toBe(0o600)
  expect(removeCredential('a', e)).toBe(true)
  expect(readCredentials(e)).toEqual({ b: 'k2' })
  expect(leftovers(e)).toEqual([])
})

test('file kredensial rusak: dipindahkan (bukan dihapus) + peringatan stderr', () => {
  const e = env()
  writeFileSync(credsPath(e), '{"a": "k1"') // truncated by a crash mid-write
  const warn = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    expect(readCredentials(e)).toEqual({})
    const backups = readdirSync(home(e)).filter((f) => f.startsWith('credentials.corrupt-'))
    expect(backups).toHaveLength(1)
    expect(readFileSync(join(home(e), backups[0] as string), 'utf8')).toBe('{"a": "k1"')
    expect(existsSync(credsPath(e))).toBe(false)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).toContain('credentials')
  } finally {
    warn.mockRestore()
  }
})

test('kredensial rusak hanya dipindahkan sekali; tulis berikutnya tidak menimpa salinan', () => {
  const e = env()
  writeFileSync(credsPath(e), '{oops')
  const warn = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    readCredentials(e)
    readCredentials(e) // second read: original is gone, no second quarantine
    expect(readdirSync(home(e)).filter((f) => f.startsWith('credentials.corrupt-'))).toHaveLength(1)
    saveCredential('a', 'k', e)
    expect(readCredentials(e)).toEqual({ a: 'k' })
    const [backup] = readdirSync(home(e)).filter((f) => f.startsWith('credentials.corrupt-'))
    expect(readFileSync(join(home(e), backup as string), 'utf8')).toBe('{oops')
  } finally {
    warn.mockRestore()
  }
})
