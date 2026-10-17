import { expect, test } from 'vitest'
import type { spawnSync } from 'node:child_process'
import { runNpmSync } from '../src/npmRunner'

type SpawnFake = typeof spawnSync

function fakeSpawn(results: { status?: number | null; stdout?: string; stderr?: string; error?: { message: string } } = {}) {
  const calls: { file: string; args: string[]; opts: Record<string, unknown> }[] = []
  const spawn = ((file: string, args: string[], opts: Record<string, unknown>) => {
    calls.push({ file, args, opts })
    const status = 'status' in results ? results.status : 0
    return { status, stdout: results.stdout ?? '', stderr: results.stderr ?? '', ...results.error ? { error: results.error } : {} }
  }) as unknown as SpawnFake
  return { spawn, calls }
}

const CLI = 'C:\\nodejs\\node_modules\\npm\\bin\\npm-cli.js'
const NODE = 'C:\\nodejs\\node.exe'

const winEnv = (path: string) => ({ PATH: path }) as NodeJS.ProcessEnv
const onlyCli = (p: string) => p === CLI
const never = () => false

// Empat kelas path wajib dari spec canary — argumen HARUS diteruskan mentah sebagai
// SATU elemen argv (tanpa join shell / quoting cmd.exe).
const HOSTILE_PATHS = [
  'C:\\Users\\x\\AppData\\Local\\Temp\\bccli with space\\home',
  'C:\\Users\\x\\AppData\\Local\\Temp\\bccli&nospaces\\home',
  'C:\\Users\\x\\AppData\\Local\\Temp\\bccli(parens)\\home',
  'C:\\Users\\x\\AppData\\Local\\Temp\\50%off\\home',
]

test('win32: memakai node + npm-cli.js TANPA shell — argv prefix mentah utk 4 kelas path', () => {
  for (const prefix of HOSTILE_PATHS) {
    const { spawn, calls } = fakeSpawn()
    const r = runNpmSync(prefix, ['install', 'ms@2.0.0'], {
      platform: 'win32',
      spawn,
      execPath: NODE,
      env: winEnv(''),
      exists: onlyCli,
    })
    expect(r.code).toBe(0)
    expect(calls).toHaveLength(1)
    const call = calls[0]
    expect(call.file).toBe(NODE)
    expect(call.args).toEqual([CLI, '--prefix', prefix, 'install', 'ms@2.0.0'])
    // REGRESI: prefix sebagai elemen argv tunggal, persis karakter asli (&, %, (), spasi)
    expect(call.args[2]).toBe(prefix)
    expect(call.args).not.toContain(expect.stringContaining(' & '))
    // Tidak ada shell cmd.exe yang dilibatkan
    expect(call.opts.shell === undefined || call.opts.shell === false).toBe(true)
  }
})

test('win32: fallback PATH — npm.cmd ditemukan di PATH, CLI diturunkan dari direktorinya', () => {
  const prefix = HOSTILE_PATHS[1] // & tanpa spasi
  const dir = 'C:\\npm-global'
  const cli = `${dir}\\node_modules\\npm\\bin\\npm-cli.js`
  const { spawn, calls } = fakeSpawn()
  const r = runNpmSync(prefix, ['uninstall', 'ms'], {
    platform: 'win32',
    spawn,
    execPath: NODE,
    env: winEnv(`${dir};C:\\other`),
    exists: (p) => p === cli || p === `${dir}\\npm.cmd`,
  })
  expect(r.code).toBe(0)
  expect(calls[0].args).toEqual([cli, '--prefix', prefix, 'uninstall', 'ms'])
})

test('win32: npm CLI tak ditemukan (sebelah node & PATH) → code 1 + pesan jelas', () => {
  const r = runNpmSync('C:\\any', ['install', 'x'], {
    platform: 'win32',
    spawn: fakeSpawn().spawn,
    execPath: NODE,
    env: winEnv('C:\\emptydir'),
    exists: never,
  })
  expect(r.code).toBe(1)
  expect(r.stderr).toMatch(/npm CLI not found/)
})

test('win32: kegagalan spawn (error) → code 1 + pesan error masuk stderr', () => {
  const { spawn } = fakeSpawn({ status: null, error: { message: 'spawn ENOENT' } })
  const r = runNpmSync('C:\\any', ['install', 'x'], {
    platform: 'win32',
    spawn,
    execPath: NODE,
    env: winEnv(''),
    exists: onlyCli,
  })
  expect(r.code).toBe(1)
  expect(r.stderr).toContain('spawn ENOENT')
})

test('posix: spawn npm biner apa adanya, tanpa shell', () => {
  const { spawn, calls } = fakeSpawn()
  const r = runNpmSync('/tmp/home', ['install', 'ms@2.0.0'], {
    platform: 'linux',
    spawn,
    execPath: '/usr/bin/node',
    env: { PATH: '/usr/bin' } as NodeJS.ProcessEnv,
    exists: never,
  })
  expect(r.code).toBe(0)
  expect(calls[0].file).toBe('npm')
  expect(calls[0].args).toEqual(['--prefix', '/tmp/home', 'install', 'ms@2.0.0'])
  expect(calls[0].opts.shell === undefined || calls[0].opts.shell === false).toBe(true)
})

test('stderr npm diteruskan utuh (untuk pesan 404 dkk)', () => {
  const { spawn } = fakeSpawn({ status: 1, stderr: 'npm error 404 not found' })
  const r = runNpmSync('C:\\x', ['install', 'missing-pkg'], {
    platform: 'win32',
    spawn,
    execPath: NODE,
    env: winEnv(''),
    exists: onlyCli,
  })
  expect(r.code).toBe(1)
  expect(r.stderr).toContain('npm error 404')
})
