import type { ChatMessage } from '../provider'

export function exportMarkdown(messages: ChatMessage[], title: string): string {
  const parts = [`# ${title}`, '']
  for (const m of messages) {
    if (m.role === 'user') parts.push('## User', '', String(m.content), '')
    else if (m.role === 'assistant') {
      for (const c of m.tool_calls ?? []) parts.push(`⎿ ${c.function.name} ${c.function.arguments.slice(0, 200)}`, '')
      if (m.content) parts.push('## BCCLI', '', m.content, '')
    }
  }
  return parts.join('\n')
}
