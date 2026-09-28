export const REASONING_LEVELS = ['auto', 'off', 'low', 'medium', 'high', 'max'] as const

export type ReasoningLevel = (typeof REASONING_LEVELS)[number]

export interface ReasoningCapability {
  levels: readonly ReasoningLevel[]
  parameter: 'reasoning_effort' | 'reasoning'
}

const OPENAI_LEVELS: readonly ReasoningLevel[] = ['auto', 'low', 'medium', 'high']
const BOTCONNECTOR_LEVELS: readonly ReasoningLevel[] = REASONING_LEVELS

export function isReasoningLevel(value: string): value is ReasoningLevel {
  return (REASONING_LEVELS as readonly string[]).includes(value)
}

export function parseReasoningLevel(value: string, label = 'reasoning'): ReasoningLevel {
  if (!isReasoningLevel(value)) {
    throw new Error(`${label} harus salah satu dari: ${REASONING_LEVELS.join(', ')}`)
  }
  return value
}

export function reasoningCapability(providerId?: string): ReasoningCapability | undefined {
  switch (providerId) {
    case 'bc-cloud':
      return { levels: BOTCONNECTOR_LEVELS, parameter: 'reasoning_effort' }
    case 'openai':
      return { levels: OPENAI_LEVELS, parameter: 'reasoning_effort' }
    case 'openrouter':
      return { levels: ['auto', 'low', 'medium', 'high'], parameter: 'reasoning' }
    default:
      return undefined
  }
}

export function supportedReasoningLevels(providerId?: string): readonly ReasoningLevel[] {
  return reasoningCapability(providerId)?.levels ?? ['auto']
}

export function assertReasoningSupported(providerId: string | undefined, level: ReasoningLevel): void {
  if (level === 'auto') return
  const capability = reasoningCapability(providerId)
  if (!capability) {
    throw new Error('Provider ini belum memiliki kontrak reasoning manual. Gunakan Auto.')
  }
  if (!capability.levels.includes(level)) {
    const supported = capability.levels.filter((x) => x !== 'auto').map(capitalize).join('/')
    throw new Error(`Model/provider ini tidak mendukung reasoning level '${level}'. Gunakan Auto${supported ? `/${supported}` : ''}.`)
  }
}

export function reasoningPayload(providerId: string | undefined, level: ReasoningLevel): Record<string, unknown> {
  if (level === 'auto') return {}
  assertReasoningSupported(providerId, level)
  const capability = reasoningCapability(providerId)!
  if (capability.parameter === 'reasoning') return { reasoning: { effort: level } }
  return { reasoning_effort: level }
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1)
}
