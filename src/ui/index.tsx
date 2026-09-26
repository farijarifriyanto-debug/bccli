import { render } from 'ink'
import type { Runtime } from '../setup'
import { App } from './App'

export async function startInteractive(rt: Runtime, opts: { initialPrompt?: string; resume: boolean; version: string }): Promise<number> {
  if (opts.resume) {
    const { Session } = await import('../session')
    const list = Session.list(rt.home, rt.cwd).slice(0, 20)
    if (!list.length) console.log('Belum ada sesi di folder ini; memulai sesi baru.')
    else {
      list.forEach((s, i) => {
        console.log(`${String(i + 1).padStart(2)}. ${s.mtime.toLocaleString('id-ID')}  ${s.preview}`)
      })
      const { createInterface } = await import('node:readline/promises')
      const rl = createInterface({ input: process.stdin, output: process.stdout })
      const answer = Number(await rl.question('Nomor sesi (enter = baru): '))
      rl.close()
      const chosen = list[answer - 1]
      if (chosen) rt.resume(chosen.session)
    }
  }
  const instance = render(<App runtime={rt} initialPrompt={opts.initialPrompt} version={opts.version} />, { exitOnCtrlC: true })
  await instance.waitUntilExit()
  return 0
}
