import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runTask, streamTask } from '../src/sdk'
import type { ChatRequest, Completion, Provider } from '../src/provider'

function scripted(steps: Completion[]): Provider & { requests: ChatRequest[] } {
  const requests: ChatRequest[] = []
  return {
    requests,
    async chat(req: ChatRequest): Promise<Completion> {
      requests.push(req)
      const next = steps[Math.min(requests.length - 1, steps.length - 1)]
      if (next.text) req.onText?.(next.text)
      return next
    },
    async listModels() {
      return ['sdk-model']
    },
  }
}

const reply = (text: string, usage?: { inputTokens: number; outputTokens: number }): Completion => ({ text, toolCalls: [], usage })

const env = () => ({ BCCLI_HOME: mkdtempSync(join(tmpdir(), 'bccli-sdk-')), BOTCONNECTOR_API_KEY: 'k' })

describe('sdk', () => {
  it('runTask returns the final text, usage and stopReason', async () => {
    const result = await runTask({
      prompt: 'say hi',
      provider: scripted([reply('HALO_SDK', { inputTokens: 10, outputTokens: 5 })]),
      cwd: tmpdir(),
      env: env(),
    })
    expect(result.text).toContain('HALO_SDK')
    expect(result.stopReason).toBe('done')
    expect(result.usage.inputTokens).toBe(10)
    expect(result.usage.outputTokens).toBe(5)
  })

  it('streamTask yields text events and ends with a result event', async () => {
    const events: { type: string }[] = []
    for await (const e of streamTask({
      prompt: 'say hi',
      provider: scripted([reply('STREAM_OK')]),
      cwd: tmpdir(),
      env: env(),
    })) {
      events.push(e)
    }
    expect(events.some((e) => e.type === 'text')).toBe(true)
    expect(events.at(-1)?.type).toBe('result')
  })

  it('honours an explicit model ref', async () => {
    const result = await runTask({
      prompt: 'x',
      provider: scripted([reply('MODEL_OK')]),
      cwd: tmpdir(),
      env: env(),
      model: 'bc-cloud/glm-5.3-flash',
    })
    expect(result.text).toContain('MODEL_OK')
  })
})
