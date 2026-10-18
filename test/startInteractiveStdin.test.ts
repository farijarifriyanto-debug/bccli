import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, expect, test, vi } from 'vitest'
import type { Runtime } from '../src/setup'

vi.mock('ink', () => ({ render: () => ({ waitUntilExit: async () => {}, unmount: () => {} }) }))

const sessionFixture = vi.hoisted(() => ({ id: 'sesi-fixture' }))
vi.mock('../src/session', () => ({
  Session: {
    list: () => [{ session: sessionFixture, mtime: new Date('2026-01-01T00:00:00Z'), preview: 'halo r5' }],
  },
}))

// trustMode.on mengatur apakah blok permintaan-trust MCP (src/ui/index.tsx:25-35) dieksekusi.
const trustMode = vi.hoisted(() => ({ on: false }))
const setProjectTrustSpy = vi.hoisted(() => vi.fn())
vi.mock('../src/mcp/config', () => ({
  serversToStart: () => ({
    start: [],
    needTrust: trustMode.on ? [{ name: 'srv', config: { command: 'node', args: ['x.js'] } }] : [],
  }),
  setProjectTrust: setProjectTrustSpy,
}))

const { startInteractive } = await import('../src/ui/index')

// Regresi r4 t8: rl.close() dari node:readline/promises pada TTY meninggalkan stdin dalam
// keadaan read-stop (pause() — terverifikasi: pauses=1, resumes=0, isPaused=true setelah close),
// sementara Ink hanya memasang listener 'readable' tanpa resume() — event loop kehilangan ref
// aktif dan `bccli -r` keluar sendiri (exit 0) ~1 dtk setelah mount. Kontrak yang dijaga:
// setiap jalur startInteractive yang memakai rl.close() WAJIB menyisakan stdin dalam keadaan
// aktif (isPaused() === false) saat render() dipasang. Stub isTTY=true mereplikasi semantik
// pause-on-close readline TTY tanpa butuh terminal nyata, sehingga tes jalan deterministik di CI.
function makeFakes() {
  const stdin = new PassThrough({ encoding: 'utf8' })
  const stdout = new PassThrough() // tangkap prompt rl.question agar tidak bocor ke output vitest
  ;(stdin as unknown as { isTTY: boolean }).isTTY = true
  ;(stdout as unknown as { isTTY: boolean }).isTTY = true
  let resumeCalls = 0
  let pauseCalls = 0
  const origResume = stdin.resume.bind(stdin)
  const origPause = stdin.pause.bind(stdin)
  stdin.resume = (() => {
    resumeCalls++
    return origResume()
  }) as PassThrough['resume']
  stdin.pause = (() => {
    pauseCalls++
    return origPause()
  }) as PassThrough['pause']
  const real = { stdin: process.stdin, stdout: process.stdout }
  const stub = (name: 'stdin' | 'stdout', value: PassThrough) =>
    Object.defineProperty(process, name, { value: value as unknown as typeof process.stdin, configurable: true, writable: true })
  stub('stdin', stdin)
  stub('stdout', stdout)
  return {
    stdin,
    resumeCalls: () => resumeCalls,
    pauseCalls: () => pauseCalls,
    restore: () => {
      stub('stdin', real.stdin as unknown as PassThrough)
      stub('stdout', real.stdout as unknown as PassThrough)
    },
  }
}

function makeRt(prefix: string, resume = vi.fn()): Runtime {
  return {
    home: mkdtempSync(join(tmpdir(), `bccli-${prefix}-`)),
    cwd: mkdtempSync(join(tmpdir(), `bccli-${prefix}c-`)),
    resume,
    startMcp: () => Promise.resolve([]),
    mcp: { stop: async () => {} },
  } as unknown as Runtime
}

afterEach(() => {
  trustMode.on = false
  setProjectTrustSpy.mockClear()
})

test('resume prompt (-r) leaves stdin active so Ink keeps the process alive', async () => {
  const fakes = makeFakes()
  try {
    fakes.stdin.write('1\n')
    const resume = vi.fn()
    const code = await startInteractive(makeRt('r5a', resume), { resume: true, version: 'test' })
    expect(code).toBe(0)
    expect(resume).toHaveBeenCalledWith(sessionFixture)
    expect(fakes.pauseCalls()).toBeGreaterThan(0) // stdin memang sempat di-pause oleh rl.close()
    expect(fakes.stdin.isPaused()).toBe(false) // ...dan harus sudah aktif lagi sebelum render()
    expect(fakes.resumeCalls()).toBeGreaterThanOrEqual(1)
  } finally {
    fakes.restore()
  }
})

test('MCP trust prompt (first run in a repo) leaves stdin active too', async () => {
  const fakes = makeFakes()
  try {
    trustMode.on = true
    fakes.stdin.write('y\n')
    const code = await startInteractive(makeRt('r5b'), { resume: false, version: 'test' })
    expect(code).toBe(0)
    expect(setProjectTrustSpy).toHaveBeenCalledTimes(1)
    expect(setProjectTrustSpy.mock.calls[0][2]).toBe('srv')
    expect(setProjectTrustSpy.mock.calls[0][3]).toBe(true)
    expect(fakes.stdin.isPaused()).toBe(false)
    expect(fakes.resumeCalls()).toBeGreaterThanOrEqual(1)
  } finally {
    fakes.restore()
  }
})
