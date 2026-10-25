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

export function StatusBar({
  mode,
  tokens,
  cached = 0,
  estimated = false,
  busy,
  model,
  reasoning = 'auto',
}: {
  mode: PermissionMode
  /** Prompt tokens of the last model call: the size of the context, not the session total. */
  tokens: number
  /** Cache reads for the latest provider-reported model call. */
  cached?: number
  /** Local chars/4 fallback rather than provider-reported usage. */
  estimated?: boolean
  busy: boolean
  model?: string
  reasoning?: ReasoningLevel
}) {
  const danger = mode === 'allowAll'
  const cacheText = cached > 0 ? ` · ${t('{n} cached', { n: formatTokens(cached) })}` : ''
  return (
    <Text color={danger ? color('red') : undefined} dimColor={!danger}>
      {`  ${LABEL[mode]}${model ? ` · ${model}` : ''} · reasoning: ${reasoning} · ${t('shift+tab switch mode')} · ${estimated ? '~' : ''}${t('{n} tokens in context', { n: formatTokens(tokens) })}${cacheText} · ${busy ? t('esc to cancel') : t('/ for commands')}`}
    </Text>
  )
}
