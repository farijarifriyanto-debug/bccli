/**
 * Ink 8 types its streams as bare `NodeJS.ReadableStream` / `NodeJS.WritableStream`, so the TTY-only fields
 * (`isTTY`, `fd`, `columns`, `rows`) are no longer visible to TypeScript. These guards are the one place that
 * casts, so no component needs `as any` to reach them. Never read `process.stdout.isTTY` directly: `render()`
 * can be handed another stream, and the test renderer uses a fake without `isTTY`/`fd`.
 */
type TtyFields = { isTTY?: boolean; fd?: unknown }

/** True when the stream reports itself as a TTY (fake test streams may still report `true`). */
export function isTtyStream(stream: unknown): boolean {
  return typeof stream === 'object' && stream !== null && (stream as TtyFields).isTTY === true
}

/** True only for a real terminal: a TTY that also exposes a file descriptor. */
export function isRealTty(stream: unknown): boolean {
  return isTtyStream(stream) && typeof (stream as TtyFields).fd === 'number'
}

/**
 * Terminal width at render time. Reading it instead of listening to `resize` keeps the app to the single resize
 * listener Ink already owns (it re-renders the tree on resize), instead of one listener per rendered message.
 */
export function streamColumns(stream: unknown): number {
  const columns = typeof stream === 'object' && stream !== null ? (stream as { columns?: unknown }).columns : undefined
  return typeof columns === 'number' && columns > 0 ? columns : 80
}

/** Terminal height at render time; same reasoning as `streamColumns`. */
export function streamRows(stream: unknown): number {
  const rows = typeof stream === 'object' && stream !== null ? (stream as { rows?: unknown }).rows : undefined
  return typeof rows === 'number' && rows > 0 ? rows : 24
}
