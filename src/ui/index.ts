import type { Runtime } from '../setup'

export async function startInteractive(_rt: Runtime, _opts: { initialPrompt?: string; resume: boolean; version: string }): Promise<number> {
  console.error('Mode interaktif belum tersedia di build ini. Pakai bccli -p "tugas".')
  return 1
}
