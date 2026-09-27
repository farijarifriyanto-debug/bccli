import { expect, test } from 'vitest'
import { Agent } from '../src/agent'
import { Permissions } from '../src/permissions'
import type { ChatRequest, Provider } from '../src/provider'
import { recoverTextToolCalls } from '../src/textToolCalls'
import { ALL_TOOLS, toolDefinitions } from '../src/tools/index'

const defs = toolDefinitions(ALL_TOOLS)

// Verbatim shapes from a ling-3.0-flash session on BotConnector Cloud.
const MANGLED =
  '\n\nBaik, saya cek hanya baca.\n\nTool call list:\n1. Tool: `command`\n   - `command</arg_key>` = `powershell -NoProfile -Command "Write-Host \'x\'" 2>&1</arg_value><arg_key>description</arg_key>\n<arg_value>Find largest folders (read-only)</arg_value><arg_key>timeout_ms</arg_key>\n<arg_value>60000</arg_value>\n'
const MANGLED_2 =
  '\n\nCoba cara lain:\n\nTool call list:\n1. Tool: `command`\n   - `command` = `dir C:\\Users</arg_value><arg_key>description</arg_key>\n<arg_value>Check users</arg_value><arg_key>timeout_ms</arg_key>\n<arg_value>120000</arg_value>\n'

test('recovers a mangled text tool call as bash, keeping the prose and typing the arguments', () => {
  const r = recoverTextToolCalls(MANGLED, defs)
  expect(r?.text).toBe('Baik, saya cek hanya baca.')
  expect(r?.toolCalls).toHaveLength(1)
  expect(r?.toolCalls[0].name).toBe('bash')
  expect(JSON.parse(r?.toolCalls[0].arguments ?? '')).toEqual({ command: 'powershell -NoProfile -Command "Write-Host \'x\'" 2>&1', timeout_ms: 60000 })
  expect(JSON.parse(recoverTextToolCalls(MANGLED_2, defs)?.toolCalls[0].arguments ?? '')).toEqual({ command: 'dir C:\\Users', timeout_ms: 120000 })
})

test('recovers standard GLM-style calls, several in one reply', () => {
  const text =
    'Saya baca dulu.\n<tool_call>read\n<arg_key>path</arg_key>\n<arg_value>src/a.ts</arg_value>\n</tool_call>\n<tool_call>glob\n<arg_key>pattern</arg_key>\n<arg_value>**/*.md</arg_value>\n</tool_call>'
  const r = recoverTextToolCalls(text, defs)
  expect(r?.text).toBe('Saya baca dulu.')
  expect(r?.toolCalls.map((c) => [c.name, JSON.parse(c.arguments)])).toEqual([
    ['read', { path: 'src/a.ts' }],
    ['glob', { pattern: '**/*.md' }],
  ])
})

test('leaves ordinary answers alone', () => {
  expect(recoverTextToolCalls('Pakai `ls -la` untuk melihat file.', defs)).toBeNull()
  expect(recoverTextToolCalls('Tag </arg_value> tanpa argumen.', defs)).toBeNull()
})

test('the agent runs a recovered call instead of stopping', async () => {
  const requests: ChatRequest[] = []
  const replies = [
    { text: MANGLED_2.replace('dir C:\\Users', 'echo halo'), toolCalls: [] },
    { text: 'selesai', toolCalls: [] },
  ]
  const provider: Provider = {
    async chat(req) {
      requests.push(structuredClone({ ...req, signal: undefined, onText: undefined }))
      return replies.shift() as never
    },
    async listModels() {
      return []
    },
  }
  const agent = new Agent({ provider, tools: ALL_TOOLS, permissions: new Permissions('allowAll'), systemPrompt: 's', cwd: process.cwd() })
  const events: string[] = []
  agent.onEvent = (e) => events.push(e.type === 'textReplace' ? `replace:${e.text}` : e.type)
  await agent.run('cek', new AbortController().signal)
  expect(requests).toHaveLength(2)
  expect(events).toContain('replace:Coba cara lain:')
  const toolMsg = agent.messages.find((m) => m.role === 'tool')
  expect(toolMsg?.content).toContain('halo')
})
