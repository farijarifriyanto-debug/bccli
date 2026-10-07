export type KeybindAction = 'thinking' | 'toolOutput'

export const KEYBIND_ACTIONS: KeybindAction[] = ['thinking', 'toolOutput']

export const DEFAULT_KEYBINDS: Record<KeybindAction, string> = {
  thinking: 'ctrl+t',
  toolOutput: 'ctrl+o',
}

export function defaultKeybinds(): Record<KeybindAction, Keybind> {
  return Object.fromEntries(KEYBIND_ACTIONS.map((action) => [action, parseKeybind(DEFAULT_KEYBINDS[action])!])) as Record<KeybindAction, Keybind>
}

export interface Keybind {
  /** The normalized spec, for display in notices and /help. */
  spec: string
  ctrl: boolean
  meta: boolean
  /** Lowercase single letter. */
  key: string
}

/**
 * Parses "ctrl+t" / "alt+x" / "ctrl+alt+o". A modifier is required: a bare letter
 * would fire while the user types. Returns undefined for anything else so the
 * caller can produce a localized ConfigError.
 */
export function parseKeybind(raw: string): Keybind | undefined {
  const spec = raw.trim().toLowerCase()
  const parts = spec.split('+')
  const key = parts.pop() ?? ''
  if (!/^[a-z]$/.test(key)) return undefined
  if (!parts.length || new Set(parts).size !== parts.length) return undefined
  if (parts.some((p) => p !== 'ctrl' && p !== 'alt')) return undefined
  return { spec, ctrl: parts.includes('ctrl'), meta: parts.includes('alt'), key }
}

export function matchKeybind(kb: Keybind, input: string, key: { ctrl?: boolean; meta?: boolean }): boolean {
  return kb.ctrl === !!key.ctrl && kb.meta === !!key.meta && input.toLowerCase() === kb.key
}
