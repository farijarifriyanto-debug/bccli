import { contentText, type ChatMessage } from '../provider'
import { t } from '../i18n'
import { type Entry, entry } from './transcript'

/** The screen rows for a resumed conversation: a notice, then every user and assistant text message in order. */
export function replayEntries(history: ChatMessage[]): Entry[] {
  const chat = history
    .map((m) => (m.role === 'user' ? { role: 'user' as const, text: contentText(m.content) } : m.role === 'assistant' && typeof m.content === 'string' ? { role: 'assistant' as const, text: m.content } : undefined))
    .filter((m): m is { role: 'user' | 'assistant'; text: string } => !!m && !!m.text.trim())
  return [
    entry({ kind: 'notice', text: t('Resuming the session ({messages} messages saved · {chat} user/assistant chats shown).', { messages: history.length, chat: chat.length }), tone: 'info' }),
    ...chat.map((m) => entry(m.role === 'user' ? { kind: 'user', text: m.text } : { kind: 'assistant', text: m.text })),
  ]
}
