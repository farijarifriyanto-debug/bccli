import { afterAll, beforeAll, expect, test } from 'vitest'
import { GhBotHub, ghBotConfigFrom, type GhBotHubDeps } from '../src/ghBotDispatch'
import { setLanguage } from '../src/i18n'
import type { CommentDelivery } from '../src/ghBotWebhook'

beforeAll(() => setLanguage('en'))
afterAll(() => setLanguage('id'))

const cfg = (over: Record<string, unknown> = {}) =>
  ghBotConfigFrom({ enabled: true, repos: ['acme/demo'], users: ['alice'], ...over })

const d = (over: Partial<CommentDelivery> = {}): CommentDelivery => ({
  delivery: `d-${Math.random().toString(36).slice(2)}`,
  event: 'issue_comment',
  action: 'created',
  repo: 'acme/demo',
  number: 1,
  isPR: false,
  author: 'alice',
  authorType: 'User',
  body: '/bccli hi',
  ...over,
})

/** Job dimulai via Promise.resolve().then → flush mikrotask/macrotask sebelum asersi. */
const tick = (): Promise<void> => new Promise<void>((r) => setImmediate(r))

function makeHub(c = cfg(), over: Partial<GhBotHubDeps> = {}) {
  const gate: Array<() => void> = []
  const errLines: string[] = []
  const calls = { jobs: [] as string[], signals: [] as AbortSignal[] }
  const deps: GhBotHubDeps = {
    out: () => {},
    err: (s) => errLines.push(s),
    runJob: (del, signal) => {
      calls.jobs.push(del.delivery)
      calls.signals.push(signal)
      return new Promise((resolve) => {
        gate.push(() => resolve({ ok: true }))
        signal.addEventListener('abort', () => resolve({ ok: false, reason: 'aborted' }))
      })
    },
    ...over,
  }
  const h = new GhBotHub(c, deps)
  return {
    h,
    calls,
    errLines,
    gate, // SATU gate per harness — runJob custom test HARUS memakai gate ini
    // Flush mikrotask dulu (job dimulai via Promise.resolve().then) baru lepas gate.
    releaseAll: async () => {
      await tick()
      while (gate.length) gate.shift()?.()
    },
  }
}

test('filter: action/event/bot/repo/user/allowlist-koong/command → filtered tanpa state', () => {
  const cases: Array<[string, CommentDelivery, Record<string, unknown>]> = [
    ['edited', d({ action: 'edited' }), {}],
    ['deleted', d({ action: 'deleted' }), {}],
    ['event lain', d({ event: 'pull_request_review_comment' }), {}],
    ['bot', d({ authorType: 'Bot' }), {}],
    ['repo tak allowlist', d({ repo: 'other/repo' }), {}],
    ['user tak allowlist', d({ author: 'bob' }), {}],
    ['tanpa perintah', d({ body: 'plain comment' }), {}],
    ['perintah kosong', d({ body: '/bccli' }), {}],
    ['allowlist repo kosong', d(), { repos: [] }],
    ['allowlist user kosong', d(), { users: [] }],
  ]
  for (const [label, delivery, over] of cases) {
    const { h, calls } = makeHub(cfg(over))
    expect(h.accept(delivery), label).toBe('filtered')
    expect(h.stats().inflight, label).toBe(0)
    expect(calls.jobs, label).toHaveLength(0)
  }
  // perintah kosong juga LOG (tanpa payload)
  const { h, errLines } = makeHub()
  h.accept(d({ body: '/bccli' }))
  expect(errLines.join('\n')).toContain('empty command')
  expect(errLines.join('\n')).not.toContain('secret')
})

test('admission atomik: queued → sukses → completed LRU → dedup; aktif → inflight', async () => {
  const { h, calls, releaseAll } = makeHub()
  const first = d()
  expect(h.accept(first)).toBe('queued')
  expect(h.accept(first)).toBe('inflight') // masih berjalan — bukan diproses dua kali
  await tick()
  expect(calls.jobs).toHaveLength(1)
  releaseAll()
  await h.whenIdle()
  expect(h.stats()).toMatchObject({ queued: 0, active: 0, inflight: 0, completed: 1 })
  expect(h.accept(first)).toBe('dedup')
  expect(calls.jobs).toHaveLength(1)
})

test('redelivery setelah queue penuh: full TIDAK menyimpan dedup (revisi #2)', async () => {
  const { h, calls, releaseAll } = makeHub(cfg({ maxQueue: 1 }))
  const a = d({ delivery: 'dA' })
  const b = d({ delivery: 'dB' })
  const c = d({ delivery: 'dC' })
  expect(h.accept(a)).toBe('queued') // jadi aktif
  expect(h.accept(b)).toBe('queued') // menunggu (antrian 1)
  expect(h.accept(c)).toBe('full') // antrian penuh — TANPA reservasi dedup
  await tick()
  expect(calls.jobs).toHaveLength(1)
  await releaseAll() // selesaikan a → b mulai (gate baru)
  await tick()
  expect(calls.jobs).toHaveLength(2)
  await releaseAll() // selesaikan b → idle (c tak ada di antrean)
  await h.whenIdle()
  // redelivery c setelah kapasitas longgar → MASIH bisa diproses
  expect(h.accept(c)).toBe('queued')
  await tick()
  expect(calls.jobs).toHaveLength(3)
  await releaseAll()
  await h.whenIdle()
  expect(h.accept(c)).toBe('dedup') // kini masuk LRU setelah sukses
})

test('duplicate aktif saat LRU penuh → inflight, bukan proses ganda', async () => {
  const { h, calls, releaseAll } = makeHub(cfg({ dedupCap: 2 }))
  // isi LRU dgn 2 delivery sukses lain
  for (const x of [d({ delivery: 'L1' }), d({ delivery: 'L2' })]) {
    expect(h.accept(x)).toBe('queued')
    releaseAll()
    await h.whenIdle()
  }
  const active = d({ delivery: 'ACTIVE' })
  expect(h.accept(active)).toBe('queued')
  // duplikat delivery yg sedang aktif walau LRU sudah penuh
  expect(h.accept(active)).toBe('inflight')
  await tick()
  expect(calls.jobs.filter((j) => j === 'ACTIVE')).toHaveLength(1)
  releaseAll()
  await h.whenIdle()
})

test('job gagal (ok:false) tidak masuk LRU — delivery bisa diulang', async () => {
  const { h, calls, gate } = makeHub(cfg(), {
    runJob: (_del, signal) => {
      calls.jobs.push(_del.delivery)
      return new Promise((resolve) => {
        gate.push(() => resolve({ ok: false, reason: 'boom' }))
        signal.addEventListener('abort', () => resolve({ ok: false, reason: 'aborted' }))
      })
    },
  })
  const x = d({ delivery: 'FAIL' })
  expect(h.accept(x)).toBe('queued')
  await tick()
  gate.shift()?.()
  await h.whenIdle()
  expect(h.stats().completed).toBe(0)
  expect(h.accept(x)).toBe('queued') // gagal → boleh diulang (redelivery manual)
  await tick()
  gate.shift()?.()
  await h.whenIdle()
  expect(h.stats().completed).toBe(0) // masih gagal → tidak masuk LRU
})

test('concurrency maxActive=1 FIFO + deadline signal per job (timeoutMs kecil → signal abort)', async () => {
  const { h, calls, releaseAll } = makeHub(cfg({ maxActive: 1, timeoutMs: 50 }))
  expect(h.accept(d({ delivery: 'J1' }))).toBe('queued')
  expect(h.accept(d({ delivery: 'J2' }))).toBe('queued')
  await tick()
  expect(calls.jobs).toEqual(['J1']) // hanya 1 aktif
  expect(h.stats().queued).toBe(1)
  // deadline: signal job pertama abort otomatis setelah 50ms → runJob resolve via listener
  await new Promise((r) => setTimeout(r, 80))
  await tick() // J1 selesai → finally pump memulai J2
  expect(calls.jobs).toEqual(['J1', 'J2']) // FIFO — J2 menyusul
  await releaseAll() // lepas gate J2
  await h.whenIdle()
  expect(h.stats()).toMatchObject({ queued: 0, active: 0, inflight: 0 })
})

test('close: buang antrian + hapus ID dari inFlight + ringkasan confirmed (rapihan #4)', async () => {
  const { h, calls, errLines } = makeHub()
  expect(h.accept(d({ delivery: 'A1' }))).toBe('queued') // aktif
  expect(h.accept(d({ delivery: 'Q1' }))).toBe('queued') // antrian
  await tick() // pastikan job aktif BENAR berjalan (listener abort terpasang) sebelum close
  expect(h.stats().inflight).toBe(2)
  const summary = await h.close() // aktif ter-abort via closeSignal; antrian dibuang
  expect(h.stats()).toEqual({ queued: 0, active: 0, inflight: 0, completed: 0 })
  expect(calls.jobs).toHaveLength(1) // antrian tak pernah jalan
  expect(summary).toEqual({ aborted: 1, terminationConfirmed: 1, terminationUnconfirmed: 0 })
  expect(errLines.join('\n')).not.toContain('UNCONFIRMED')
  expect(h.accept(d({ delivery: 'NEW' }))).toBe('closed')
})

test('close dua arah: reason termination-unconfirmed → summary + baris log (kasus 6b)', async () => {
  const { h, errLines } = makeHub(cfg(), {
    runJob: (_del, signal) =>
      new Promise((resolve) => {
        signal.addEventListener('abort', () => resolve({ ok: false, reason: 'termination-unconfirmed' }))
      }),
  })
  expect(h.accept(d({ delivery: 'HARD' }))).toBe('queued')
  await tick() // job harus sudah berjalan agar abort listener terpasang sebelum close
  const summary = await h.close()
  expect(summary).toEqual({ aborted: 1, terminationConfirmed: 0, terminationUnconfirmed: 1 })
  expect(errLines.join('\n')).toMatch(/UNCONFIRMED 1 .*child may still be running/)
  expect(h.stats().completed).toBe(0) // TIDAK masuk completed LRU (koreksi #1)
})

test('throw SINKRON (8a) dibungkus Promise.resolve().then — cleanup + antrean lanjut', async () => {
  let call = 0
  const { h, calls, errLines, gate, releaseAll } = makeHub(cfg(), {
    runJob: (del, signal) => {
      call++
      calls.jobs.push(del.delivery)
      if (call === 1) {
        throw new Error('sync-boom') // MELEMPAR LANGSUNG — bukan rejected promise
      }
      return new Promise((resolve) => {
        gate.push(() => resolve({ ok: true }))
        signal.addEventListener('abort', () => resolve({ ok: false, reason: 'aborted' }))
      })
    },
  })
  expect(h.accept(d({ delivery: 'SYNC' }))).toBe('queued')
  await h.whenIdle() // throw sinkron tidak boleh memblokir pump
  expect(h.stats()).toMatchObject({ active: 0, inflight: 0 })
  expect(errLines.join('\n')).toContain('sync-boom')
  expect(h.accept(d({ delivery: 'AFTER' }))).toBe('queued') // antrean lanjut
  await tick() // job AFTER mulai → gate-nya terisi
  gate.shift()?.()
  await h.whenIdle()
  expect(h.accept(d({ delivery: 'SYNC' }))).toBe('queued') // gagal → redelivery OK
  await releaseAll()
  await h.whenIdle()
})

test('Promise rejection (8b) — cleanup identik terpisah dari throw sinkron', async () => {
  const { h, errLines } = makeHub(cfg(), {
    runJob: () => Promise.reject(new Error('async-boom')),
  })
  expect(h.accept(d({ delivery: 'REJ' }))).toBe('queued')
  await h.whenIdle()
  expect(h.stats()).toMatchObject({ active: 0, inflight: 0 })
  expect(errLines.join('\n')).toContain('async-boom')
  expect(h.accept(d({ delivery: 'REJ' }))).toBe('queued') // redelivery OK
  await h.whenIdle()
  expect(h.stats()).toMatchObject({ active: 0, inflight: 0, completed: 0 })
})

test('ghBotConfigFrom: default aman + tipe salah → ConfigError', () => {
  const defaults = ghBotConfigFrom({})
  expect(defaults).toMatchObject({
    enabled: false,
    path: '/github',
    secretEnv: 'GITHUB_WEBHOOK_SECRET',
    maxBodyBytes: 1_048_576,
    maxActive: 1,
    maxQueue: 10,
    stepLimit: 8,
    timeoutMs: 120_000,
  })
  expect(() => ghBotConfigFrom({ repos: 'x' })).toThrow()
  expect(() => ghBotConfigFrom({ maxActive: 0 })).toThrow()
  expect(() => ghBotConfigFrom({ secretEnv: '' })).toThrow()
})
