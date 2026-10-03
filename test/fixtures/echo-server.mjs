import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

import { writeFileSync } from 'node:fs'

if (process.env.PIDFILE) writeFileSync(process.env.PIDFILE, String(process.pid))

const server = new McpServer({ name: 'echo', version: '1.0.0' })
server.registerTool('echo', {
  description: 'Echo text back',
  inputSchema: { text: z.string() },
  outputSchema: { echoed: z.string() },
  annotations: { readOnlyHint: true },
}, async ({ text }) => ({
  content: [{ type: 'text', text: JSON.stringify({ echoed: `echo: ${text}` }) }],
  structuredContent: { echoed: `echo: ${text}` },
}))
server.registerTool('fail', { description: 'Always fails' }, async () => ({ content: [{ type: 'text', text: 'boom' }], isError: true }))
server.registerTool('weird.name with spaces', { description: 'Bad name' }, async () => ({ content: [{ type: 'text', text: 'ok' }] }))
await server.connect(new StdioServerTransport())
