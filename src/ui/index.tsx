import { render } from 'ink'
import type { Runtime } from '../setup'
import { App } from './App'
import { locale, t } from '../i18n'

export async function startInteractive(rt: Runtime, opts: { initialPrompt?: string; resume: boolean; version: string; updateMessage?: string }): Promise<number> {
  if (opts.resume) {
    const { Session } = await import('../session')
    const list = Session.list(rt.home, rt.cwd).slice(0, 20)
    if (!list.length) console.log(t('No sessions in this folder yet; starting a new one.'))
    else {
      list.forEach((s, i) => {
        console.log(`${String(i + 1).padStart(2)}. ${s.mtime.toLocaleString(locale())}  ${s.preview}`)
      })
      const { createInterface } = await import('node:readline/promises')
      const rl = createInterface({ input: process.stdin, output: process.stdout })
      const answer = Number(await rl.question(t('Session number (enter = new): ')))
      rl.close()
      // rl.close() meninggalkan stdin TTY dalam keadaan read-stop (pause); tanpa resume,
      // Ink tidak menahan event loop dan `bccli -r` keluar sendiri ~1 dtk setelah mount.
      process.stdin.resume()
      const chosen = list[answer - 1]
      if (chosen) rt.resume(chosen.session)
    }
  }
  const { serversToStart, setProjectTrust } = await import('../mcp/config')
  const plan = serversToStart(rt.home, rt.cwd)
  if (plan.needTrust.length) {
    const { createInterface } = await import('node:readline/promises')
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    for (const s of plan.needTrust) {
      const what = s.config.type === 'http' ? s.config.url : [s.config.command, ...(s.config.args ?? [])].join(' ')
      const answer = (await rl.question(t('This repo wants to run the MCP server "{name}" ({what}). Allow? [y/N] ', { name: s.name, what }))).trim().toLowerCase()
      setProjectTrust(rt.home, rt.cwd, s.name, answer === 'y', s.config)
      if (answer === 'y') plan.start.push(s)
    }
    rl.close()
    // Sama seperti jalur resume: aktifkan lagi stdin sebelum Ink dipasang (lihat catatan r4 t8).
    process.stdin.resume()
  }
  void rt.startMcp(plan.start).catch((error: unknown) => {
    console.error(t('Could not start MCP servers: {error}', { error: error instanceof Error ? error.message : String(error) }))
  })
  const instance = render(<App runtime={rt} initialPrompt={opts.initialPrompt} version={opts.version} updateMessage={opts.updateMessage} />, { exitOnCtrlC: true })
  await instance.waitUntilExit()
  await rt.mcp.stop()
  return 0
}
