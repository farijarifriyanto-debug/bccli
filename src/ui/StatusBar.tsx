import { Text } from 'ink'
import type { PermissionMode } from '../config'
import { color } from './theme'

const LABEL: Record<PermissionMode, string> = {
  default: '⏵ default',
  acceptEdits: '⏵ accept edits',
  plan: '⏸ plan mode',
  allowAll: '⏵⏵ allow all',
}

function formatTokens(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)
}

export function StatusBar({ mode, tokens, busy }: { mode: PermissionMode; tokens: number; busy: boolean }) {
  const danger = mode === 'allowAll'
  return (
    <Text color={danger ? color('red') : undefined} dimColor={!danger}>
      {`  ${LABEL[mode]} · shift+tab ganti mode · ${formatTokens(tokens)} token · ${busy ? 'esc batal' : '/ perintah'}`}
    </Text>
  )
}
