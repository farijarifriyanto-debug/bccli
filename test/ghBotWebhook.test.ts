import { createHmac } from 'node:crypto'
import { afterAll, beforeAll, expect, test, vi } from 'vitest'
import { setLanguage } from '../src/i18n'
import {
  extractCommand,
  signBody,
  truncateHeadTailUtf8,
  truncateUtf8Bytes,
  verifyAndParse,
} from '../src/ghBotWebhook'

beforeAll(() => setLanguage('en'))
afterAll(() => setLanguage('id'))

const SECRET = 's3cr3t-webhook'
const payload = {
  action: 'created',
  issue: { number: 42, title: 'T', body: 'IB' },
  comment: { id: 9, body: '/bccli summarize this', user: { login: 'alice', type: 'User' } },
  repository: { full_name: 'acme/demo' },
}
const body = Buffer.from(JSON.stringify(payload), 'utf8')
const H = (over: Record<string, string | undefined> = {}, raw = body): Record<string, string | undefined> => ({
  'x-hub-signature-256': signBody(raw, SECRET),
  'x-hub-delivery': 'd-1',
  'x-hub-event': 'issue_comment',
  ...over,
})
const OPTS = (
  over: Partial<{
    method: string
    contentType: string | undefined
    maxBodyBytes: number
    getSecret: () => string | undefined
  }> = {},
) => ({
  method: 'POST',
  contentType: 'application/json',
  maxBodyBytes: 1_048_576,
  getSecret: () => SECRET,
  ...over,
})

test('valid → proyeksi lengkap termasuk isPR dari payload', () => {
  const r = verifyAndParse(body, H(), OPTS())
  expect(r.ok).toBe(true)
  if (r.ok) {
    expect(r.delivery).toMatchObject({
      delivery: 'd-1',
      repo: 'acme/demo',
      number: 42,
      author: 'alice',
      authorType: 'User',
      isPR: false,
      body: '/bccli summarize this',
    })
  }
  // payload PR: field pull_request melekat di issue_comment
  const pr = { ...payload, pull_request: { url: 'x' } }
  const prBuf = Buffer.from(JSON.stringify(pr))
  const r2 = verifyAndParse(prBuf, H({}, prBuf), OPTS())
  expect(r2.ok).toBe(true)
  if (r2.ok) expect(r2.delivery.isPR).toBe(true)
})

test('urutan: method → content-type → size → header → secret → HMAC(BUFFER) → decode fatal → parse', () => {
  expect(verifyAndParse(body, H(), OPTS({ method: 'GET' }))).toMatchObject({ status: 405 })
  expect(verifyAndParse(body, H(), OPTS({ contentType: 'text/plain' }))).toMatchObject({ status: 415 })
  expect(verifyAndParse(Buffer.alloc(50), H({}, Buffer.alloc(50)), OPTS({ maxBodyBytes: 10 }))).toMatchObject({ status: 413 })
  expect(verifyAndParse(body, H({ 'x-hub-delivery': undefined }), OPTS())).toMatchObject({ status: 400 })
  expect(verifyAndParse(body, H(), OPTS({ getSecret: () => undefined }))).toMatchObject({ status: 503 })
  // signature invalid → 401 SEBELUM parse
  const spy = vi.fn((t: string) => JSON.parse(t))
  expect(verifyAndParse(body, H({ 'x-hub-signature-256': 'sha256=dead' }), OPTS(), spy)).toMatchObject({ status: 401 })
  expect(spy).not.toHaveBeenCalled()
  // byte non-UTF-8 dengan HMAC VALID → 400 (decode fatal), parse tak terpanggil
  const invalidUtf8 = Buffer.from([0xff, 0xfe, 0x41])
  const spy2 = vi.fn((t: string) => JSON.parse(t))
  expect(verifyAndParse(invalidUtf8, H({}, invalidUtf8), OPTS(), spy2)).toMatchObject({ status: 400 })
  expect(spy2).not.toHaveBeenCalled()
})

test('JSON corrupt & array ditandatangani ATAS BODY ITU → HMAC lolos, 400 dari parse (revisi #7)', () => {
  const corrupt = Buffer.from('{corrupt', 'utf8')
  const spyC = vi.fn((t: string) => JSON.parse(t))
  expect(verifyAndParse(corrupt, H({}, corrupt), OPTS(), spyC)).toMatchObject({ status: 400 })
  expect(spyC).toHaveBeenCalledTimes(1) // benar-benar menguji parse
  const arr = Buffer.from('["array"]', 'utf8')
  const spyA = vi.fn((t: string) => JSON.parse(t))
  expect(verifyAndParse(arr, H({}, arr), OPTS(), spyA)).toMatchObject({ status: 400 })
  expect(spyA).toHaveBeenCalledTimes(1)
  // field event hilang pada objek valid-BER-SIGNATURE → 400
  const bare = Buffer.from(JSON.stringify({ action: 'created' }))
  expect(verifyAndParse(bare, H({}, bare), OPTS())).toMatchObject({ status: 400 })
})

test('rotasi secret via accessor (revisi #6): secret lama → 401; secret baru → lolos', () => {
  let secret = SECRET
  const opts = OPTS({ getSecret: () => secret })
  expect(verifyAndParse(body, H(), opts).ok).toBe(true)
  secret = 'rotated-secret'
  expect(verifyAndParse(body, H(), opts)).toMatchObject({ status: 401 })
  expect(verifyAndParse(body, { ...H(), 'x-hub-signature-256': signBody(body, 'rotated-secret') }, opts).ok).toBe(true)
})

test('signBody deterministik format sha256=<hex>; rawBody byte apa adanya', () => {
  expect(signBody(body, SECRET)).toMatch(/^sha256=[0-9a-f]{64}$/)
  const messy = Buffer.from('{\n  "a": 1  }', 'utf8')
  expect(signBody(messy, SECRET)).toBe(`sha256=${createHmac('sha256', SECRET).update(messy).digest('hex')}`)
})

test('extractCommand: valid/whitespace/kosong/bukan perintah/batas kata', () => {
  expect(extractCommand('/bccli fix the bug')).toBe('fix the bug')
  expect(extractCommand('  /bccli   hello  ')).toBe('hello')
  expect(extractCommand('/bccli')).toBeNull()
  expect(extractCommand('/bcl')).toBeNull()
  expect(extractCommand('/bcclix nope')).toBeNull()
  expect(extractCommand('plain comment')).toBeNull()
})

test('truncateUtf8Bytes: tak pernah memotong karakter — emoji/CJK utuh, byteLength ≤ max', () => {
  const text = '😀漢字'.repeat(500)
  const out = truncateUtf8Bytes(text, 100)
  expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(100)
  expect(out.includes('�')).toBe(false) // tanpa replacement char
  expect(out).not.toMatch(/[\uD800-\uDBFF]$/) // surrogate tak terbelah
  expect(truncateUtf8Bytes('pendek', 100)).toBe('pendek')
})

test('truncateHeadTailUtf8: ≤max byte, 60/40 kepala-ekor + marker, karakter utuh', () => {
  const head = 'H'.repeat(600)
  const tail = '😀'.repeat(300) // 4 byte/char
  const out = truncateHeadTailUtf8(head + tail, 200)
  expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(200)
  expect(out).toContain('truncated')
  expect(out.startsWith('H')).toBe(true)
  expect(out).not.toMatch(/[\uD800-\uDBFF]$/)
  expect(truncateHeadTailUtf8('small', 100)).toBe('small')
})
