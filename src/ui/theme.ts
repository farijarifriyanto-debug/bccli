export const THEMES = ['default', 'blue', 'amber', 'magenta', 'mono'] as const

/** Per-theme remap of the ink color names used at the call sites; anything unmapped passes through. */
const REMAP: Record<string, Record<string, string>> = {
  blue: { green: 'blue' },
  amber: { green: 'yellow' },
  magenta: { green: 'magenta' },
}

let theme: string = 'default'

export function setTheme(name: string): void {
  theme = name
}

export function currentTheme(): string {
  return theme
}

export function color(name: string): string | undefined {
  if (process.env.NO_COLOR) return undefined
  if (theme === 'mono') return undefined
  return REMAP[theme]?.[name] ?? name
}

export const ACCENT = 'green'
