import { expect, test } from 'vitest'
import { prTaskArgv, runPrCommand } from '../src/prCli'

function fakeGh(calls: string[][]) {
  return async (argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> => {
    calls.push(argv)
    if (argv[0] === 'pr' && argv[1] === 'checkout') return { code: 0, stdout: '', stderr: '' }
    if (argv[0] === '--version') return { code: 0, stdout: 'gh version 2.0.0', stderr: '' }
    return { code: 0, stdout: '', stderr: '' }
  }
}

test('pr checks out the PR with gh pr checkout and does not allow every tool', async () => {
  const calls: string[][] = []
  const ran: { prompt?: string; allowAll?: boolean }[] = []
  const code = await runPrCommand(
    { subArgs: ['42'], cwd: '/repo' },
    {
      out: () => {},
      err: () => {},
      gh: fakeGh(calls),
      runTask: async (opts) => {
        ran.push(opts)
        return 0
      },
    },
  )
  expect(code).toBe(0)
  expect(calls[0]).toEqual(['pr', 'checkout', '42'])
  expect(ran).toHaveLength(1)
  expect(ran[0].allowAll).toBe(false)
})

test('pr allows every tool only when the caller asked with --allow-all', async () => {
  const ran: { prompt?: string; allowAll?: boolean }[] = []
  const code = await runPrCommand(
    { subArgs: ['42', 'fix', 'it'], cwd: '/repo', allowAll: true },
    {
      out: () => {},
      err: () => {},
      gh: fakeGh([]),
      runTask: async (opts) => {
        ran.push(opts)
        return 0
      },
    },
  )
  expect(code).toBe(0)
  expect(ran[0].allowAll).toBe(true)
  expect(ran[0].prompt).toBe('fix it')
})

test('pr warns on stderr when the task runs with every tool allowed', async () => {
  const errs: string[] = []
  await runPrCommand(
    { subArgs: ['42'], cwd: '/repo', allowAll: true },
    { out: () => {}, err: (l) => errs.push(l), gh: fakeGh([]), runTask: async () => 0 },
  )
  expect(errs.join('\n')).toMatch(/allow-all/i)
})

test('pr stays quiet about allow-all when the safe default is used', async () => {
  const errs: string[] = []
  await runPrCommand(
    { subArgs: ['42'], cwd: '/repo' },
    { out: () => {}, err: (l) => errs.push(l), gh: fakeGh([]), runTask: async () => 0 },
  )
  expect(errs.join('\n')).not.toMatch(/allow-all/i)
})

test('the pr task argv adds --allow-all only when the task is allowed to use every tool', () => {
  expect(prTaskArgv('/dist/cli.js', { prompt: 'review this', allowAll: false })).toEqual([
    '/dist/cli.js',
    '-p',
    'review this',
  ])
  expect(prTaskArgv('/dist/cli.js', { prompt: 'review this', allowAll: true })).toEqual([
    '/dist/cli.js',
    '-p',
    'review this',
    '--allow-all',
  ])
  expect(prTaskArgv('/dist/cli.js', {})).toEqual(['/dist/cli.js'])
})

test('pr with --repo passes it to gh', async () => {
  const calls: string[][] = []
  await runPrCommand(
    { subArgs: ['7', '--repo', 'owner/name'], cwd: '/repo' },
    {
      out: () => {},
      err: () => {},
      gh: fakeGh(calls),
      runTask: async () => 0,
    },
  )
  expect(calls[0]).toEqual(['pr', 'checkout', '7', '--repo', 'owner/name'])

  const calls2: string[][] = []
  await runPrCommand(
    { subArgs: ['8'], repo: 'parsed/repo', model: 'bc-cloud/gpt-oss-120b', cwd: '/repo' },
    {
      out: () => {},
      err: () => {},
      gh: fakeGh(calls2),
      runTask: async () => 0,
    },
  )
  expect(calls2[0]).toEqual(['pr', 'checkout', '8', '--repo', 'parsed/repo'])
  expect(prTaskArgv('/dist/cli.js', { prompt: 'review', model: 'bc-cloud/gpt-oss-120b' })).toEqual([
    '/dist/cli.js',
    '-p',
    'review',
    '-m',
    'bc-cloud/gpt-oss-120b',
  ])
})

test('pr forwards the remaining words as the task', async () => {
  const calls: string[][] = []
  const ran: { prompt?: string }[] = []
  await runPrCommand(
    { subArgs: ['3', 'run', 'the', 'tests'], cwd: '/repo' },
    {
      out: () => {},
      err: () => {},
      gh: fakeGh(calls),
      runTask: async (opts) => {
        ran.push(opts)
        return 0
      },
    },
  )
  expect(ran[0].prompt).toBe('run the tests')
})

test('pr without a number errors', async () => {
  const errs: string[] = []
  const code = await runPrCommand({ subArgs: [], cwd: '/repo' }, { out: () => {}, err: (l) => errs.push(l), gh: async () => ({ code: 0, stdout: '', stderr: '' }), runTask: async () => 0 })
  expect(code).toBe(1)
  expect(errs.join('\n')).toMatch(/usage|pakai/i)
})

test('pr rejects a non-numeric number', async () => {
  const errs: string[] = []
  const code = await runPrCommand({ subArgs: ['abc'], cwd: '/repo' }, { out: () => {}, err: (l) => errs.push(l), gh: async () => ({ code: 0, stdout: '', stderr: '' }), runTask: async () => 0 })
  expect(code).toBe(1)
  expect(errs.join('\n')).toMatch(/usage|pakai|nomor|number/i)
})

test('pr fails clearly when gh is missing', async () => {
  const errs: string[] = []
  const code = await runPrCommand(
    { subArgs: ['1'], cwd: '/repo' },
    {
      out: () => {},
      err: (l) => errs.push(l),
      gh: async () => {
        throw new Error('spawn gh ENOENT')
      },
      runTask: async () => 0,
    },
  )
  expect(code).toBe(1)
  expect(errs.join('\n')).toMatch(/gh/i)
})

test('pr fails when checkout fails and does not run a task', async () => {
  const errs: string[] = []
  let taskRan = false
  const code = await runPrCommand(
    { subArgs: ['9'], cwd: '/repo' },
    {
      out: () => {},
      err: (l) => errs.push(l),
      gh: async (argv) => {
        if (argv[0] === 'pr') return { code: 1, stdout: '', stderr: 'no such pr' }
        return { code: 0, stdout: '', stderr: '' }
      },
      runTask: async () => {
        taskRan = true
        return 0
      },
    },
  )
  expect(code).toBe(1)
  expect(taskRan).toBe(false)
  expect(errs.join('\n')).toMatch(/checkout/i)
})

test('pr returns the task exit code', async () => {
  const code = await runPrCommand(
    { subArgs: ['5'], cwd: '/repo' },
    {
      out: () => {},
      err: () => {},
      gh: fakeGh([]),
      runTask: async () => 3,
    },
  )
  expect(code).toBe(3)
})
