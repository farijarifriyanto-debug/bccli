import { describe, expect, test } from 'vitest'
import { MAX_FRAME_BYTES, bearerOk, parseClientFrame, randomToken, trustFence } from '../src/serveProtocol'

describe('parseClientFrame', () => {
  test('open valid', () => {
    expect(parseClientFrame('{"type":"open","streamId":"a","target":"session:x"}')).toEqual({
      type: 'open',
      streamId: 'a',
      target: 'session:x',
    })
  })
  test('cancel valid', () => {
    expect(parseClientFrame('{"type":"cancel","streamId":"a"}')).toEqual({ type: 'cancel', streamId: 'a' })
  })
  test('json rusak → error', () => {
    expect(parseClientFrame('{')).toMatchObject({ error: expect.any(String) })
  })
  test('type tak dikenal → error', () => {
    expect(parseClientFrame('{"type":"item","streamId":"a"}')).toMatchObject({ error: expect.any(String) })
  })
  test('open tanpa target → error', () => {
    expect(parseClientFrame('{"type":"open","streamId":"a"}')).toMatchObject({ error: expect.any(String) })
  })
  test('streamId kosong → error', () => {
    expect(parseClientFrame('{"type":"cancel","streamId":""}')).toMatchObject({ error: expect.any(String) })
  })
})

describe('trustFence', () => {
  const H = (over: Record<string, string> = {}) => ({ host: '127.0.0.1:8787', ...over })
  test('loopback polos lolos', () => expect(trustFence(H(), 8787)).toBeNull())
  test('localhost + ::1 lolos', () => {
    expect(trustFence(H({ host: 'localhost:8787' }), 8787)).toBeNull()
    expect(trustFence(H({ host: '[::1]:8787' }), 8787)).toBeNull()
  })
  test('Host non-loopback → alasan 403', () => expect(trustFence(H({ host: 'evil.com' }), 8787)).toBeTruthy())
  test('port Host tidak cocok listener → 403', () =>
    expect(trustFence(H({ host: '127.0.0.1:9999' }), 8787)).toBeTruthy())
  test('Origin beda → 403; Origin sama → lolos', () => {
    expect(trustFence(H({ origin: 'http://evil.com' }), 8787)).toBeTruthy()
    expect(trustFence(H({ origin: 'http://127.0.0.1:8787' }), 8787)).toBeNull()
  })
  test('Origin malformed → 403', () => expect(trustFence(H({ origin: 'bukan-url' }), 8787)).toBeTruthy())
  test('sec-fetch-site cross-site → 403; same-origin → lolos', () => {
    expect(trustFence(H({ 'sec-fetch-site': 'cross-site' }), 8787)).toBeTruthy()
    expect(trustFence(H({ 'sec-fetch-site': 'same-origin' }), 8787)).toBeNull()
  })
  test('Host hilang → 403', () => expect(trustFence({ host: undefined }, 8787)).toBeTruthy())
})

describe('bearerOk', () => {
  test('token cocok', () => expect(bearerOk('Bearer abc123', 'abc123')).toBe(true))
  test('token salah / header hilang / skema salah', () => {
    expect(bearerOk('Bearer nope', 'abc123')).toBe(false)
    expect(bearerOk(undefined, 'abc123')).toBe(false)
    expect(bearerOk('abc123', 'abc123')).toBe(false)
  })
})

test('randomToken 64 hex, unik; MAX_FRAME_BYTES 256KB', () => {
  const a = randomToken()
  expect(a).toMatch(/^[0-9a-f]{64}$/)
  expect(randomToken()).not.toBe(a)
  expect(MAX_FRAME_BYTES).toBe(262144)
})
