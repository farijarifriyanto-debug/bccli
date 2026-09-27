import type { Runtime } from './setup'

interface Writer {
  write(s: string): unknown
}

export function toolLabel(tool: string): string {
  if (tool === 'web_search') return 'Search'
  return tool.charAt(0).toUpperCase() + tool.slice(1)
}

export async function runPrint(
  rt: Runtime,
  prompt: string,
  io: { out: Writer; err: Writer } = { out: process.stdout, err: process.stderr },
  opts: { allowAll?: boolean } = {},
): Promise<number> {
  rt.interaction.approvePlan = async () => {
    if (opts.allowAll) return 'allowAll'
    io.err.write('Rencana butuh persetujuan; jalankan dengan --allow-all.\n')
    return 'no'
  }
  let failed = false
  let wroteText = false
  rt.agent.onEvent = (event) => {
    switch (event.type) {
      case 'text':
        io.out.write(event.delta)
        wroteText = true
        break
      case 'toolStart':
        io.err.write(`⎿ ${toolLabel(event.tool)}  ${event.target}\n`)
        break
      case 'toolEnd':
        if (event.isError) io.err.write(`  ✗ ${event.output.split('\n')[0]}\n`)
        break
      case 'stepLimit':
        io.err.write('Batas langkah tercapai.\n')
        failed = true
        break
      case 'aborted':
        io.err.write('Dibatalkan.\n')
        failed = true
        break
      case 'error':
        io.err.write(`Error: ${event.message}\n`)
        failed = true
        break
    }
  }
  rt.agent.askPermission = async (req) => {
    io.err.write(`  Butuh izin untuk ${req.tool}. Jalankan dengan --allow-all atau --allowed-tools ${req.kind}.\n`)
    return 'no'
  }
  const controller = new AbortController()
  const onSigint = () => controller.abort()
  process.once('SIGINT', onSigint)
  try {
    await rt.agent.run(prompt, controller.signal)
  } finally {
    process.off('SIGINT', onSigint)
  }
  if (wroteText) io.out.write('\n')
  return failed ? 1 : 0
}
