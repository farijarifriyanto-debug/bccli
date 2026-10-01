import { Text } from 'ink'
import type { PermissionMode } from '../config'
import type { ReasoningLevel } from '../reasoning'
import { color } from './theme'
import { t } from '../i18n'

const LABEL: Record<PermissionMode, string> = {
  default: '⏵ default',
  acceptEdits: '⏵ accept edits',
  plan: '⏸ plan mode',
  allowAll: '⏵⏵ allow all',
}

function formatTokens(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)
}

export function StatusBar({ mode, tokens, busy, model, reasoning = 'auto' }: { mode: PermissionMode; tokens: number; busy: boolean; model?: string; reasoning?: ReasoningLevel }) {
  const danger = mode === 'allowAll'
  return (
    <Text color={danger ? color('red') : undefined} dimColor={!danger}>
      {`  ${LABEL[mode]}${model ? ` · ${model}` : ''} · reasoning: ${reasoning} · ${t('shift+tab switch mode')} · ${t('{n} tokens', { n: formatTokens(tokens) })} · ${busy ? t('esc to cancel') : t('/ for commands')}`}
    </Text>
  )
}
