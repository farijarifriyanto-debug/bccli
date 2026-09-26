export function color(name: string): string | undefined {
  return process.env.NO_COLOR ? undefined : name
}

export const ACCENT = 'green'
