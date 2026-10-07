import type { Runtime } from './setup'
import { runHooks } from './hooks'
import { t } from './i18n'
import { MAX_VERIFY_ROUNDS, runVerify, verifyFollowup } from './verify'

interface Writer {
  write(s: string): unknown
}

export function toolLabel(tool: string): string {
  if (tool === 'web_search') return 'Search'
  return tool.charAt(0).toUpperCase() + tool.slice(1)
}

export type OutputFormat = 'text' | 'json' | 'stream-json'

export async function runPrint(
  rt: Runtime,
  prompt: string,
  io: { out: Writer; err: Writer } = { out: process.stdout, err: process.stderr },
  opts: { allowAll?: boolean; outputFormat?: OutputFormat } = {},
): Promise<number> {
  const format: OutputFormat = opts.outputFormat ?? 'text'
  const emit = (line: Record<string, unknown>) => io.out.write(`${JSON.stringify(line)}\n`)
  let result = ''
  const toolNames = new Map<string, string>()
  rt.interaction.approvePlan = async () => {
    if (opts.allowAll) return 'allowAll'
    io.err.write(`${t('Plan needs approval; run with --allow-all.')}\n`)
    return 'no'
  }
  let failed = false
  let wroteText = false
  let edited = false
  rt.agent.onEvent = (event) => {
    switch (event.type) {
      case 'text':
        if (format === 'text') {
          io.out.write(event.delta)
          wroteText = true
        } else {
          result += event.delta
        }
        break
      case 'toolStart':
        toolNames.set(event.id, event.tool)
        io.err.write(`⎿ ${toolLabel(event.tool)}  ${event.target}\n`)
        if (format === 'stream-json') emit({ type: 'tool_use', tool: event.tool, target: event.target })
        break
      case 'toolEnd':
        if (event.isError) io.err.write(`  ✗ ${event.output.split('\n')[0]}\n`)
        if ((event.tool === 'edit' || event.tool === 'write') && !event.isError) edited = true
        if (format === 'stream-json') emit({ type: 'tool_result', tool: toolNames.get(event.id), isError: !!event.isError, output: event.output })
        break
      case 'stepLimit':
        io.err.write(`${t('Step limit reached.')}\n`)
        failed = true
        break
      case 'budgetExceeded':
        io.err.write(`${t('Budget exceeded ({kind}): {used} of {limit}. Further model calls are blocked; raise usageCap in ~/.bccli/config.json.', { kind: event.kind, used: Math.round(event.used * 100) / 100, limit: event.limit })}\n`)
        if (format === 'stream-json') emit({ type: 'error', message: 'budgetExceeded' })
        failed = true
        break
      case 'aborted':
        io.err.write(`${t('Cancelled.')}\n`)
        failed = true
        break
      case 'error':
        io.err.write(`Error: ${event.message}\n`)
        if (format === 'stream-json') emit({ type: 'error', message: event.message })
        failed = true
        break
    }
  }
  rt.agent.askPermission = async (req) => {
    io.err.write(`  ${t('Needs permission for {tool}. Run with --allow-all or --allowed-tools {kind}.', { tool: req.tool, kind: req.kind })}\n`)
    return 'no'
  }
  const controller = new AbortController()
  const onSigint = () => controller.abort()
  process.once('SIGINT', onSigint)
  const start = await runHooks(rt.config.hooks, 'SessionStart', {}, { env: rt.env, cwd: rt.cwd })
  for (const warning of start.warnings) io.err.write(`${warning}\n`)
  await rt.emitPlugins('SessionStart')
  try {
    await rt.agent.run(prompt, controller.signal)
    const commands = rt.config.verifyCommands
    if (edited && commands.length && !controller.signal.aborted) {
      for (let round = 0; round < MAX_VERIFY_ROUNDS; round++) {
        io.err.write(`${t('Verifying edits: {cmds}', { cmds: commands.join(', ') })}\n`)
        const failures = await runVerify(commands, { cwd: rt.cwd, env: rt.env, signal: controller.signal })
        if (!failures.length) {
          io.err.write(`${t('Verification passed.')}\n`)
          break
        }
        if (round === MAX_VERIFY_ROUNDS - 1 || controller.signal.aborted) {
          io.err.write(`${t('Verification still failing after {n} fix round(s). Run the commands manually to see why.', { n: MAX_VERIFY_ROUNDS })}\n`)
          failed = true
          break
        }
        await rt.agent.run(verifyFollowup(failures), controller.signal)
      }
    }
  } finally {
    process.off('SIGINT', onSigint)
  }
  const stop = await runHooks(rt.config.hooks, 'Stop', {}, { env: rt.env, cwd: rt.cwd })
  for (const warning of stop.warnings) io.err.write(`${warning}\n`)
  await rt.emitPlugins('Stop')
  if (format === 'json') {
    io.out.write(`${JSON.stringify({ status: failed ? 'failed' : 'ok', model: rt.modelRef, result })}\n`)
  } else if (format === 'stream-json') {
    if (result) emit({ type: 'message', text: result })
    emit({ type: 'result', status: failed ? 'failed' : 'ok', model: rt.modelRef })
  } else if (wroteText) {
    io.out.write('\n')
  }
  return failed ? 1 : 0
}
