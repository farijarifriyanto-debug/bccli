const X10_START = '\x1b[M'
const X10_PAYLOAD = 3

/**
 * Terminals without SGR support answer mouse tracking (`\x1b[?1000h`, which bccli only turns on while the Thinking
 * block is clickable) with legacy X10 reports: `ESC [ M` followed by three raw bytes. Ink 8 drops the `ESC [ M`
 * prefix but passes those three bytes to `useInput` as if typed, so they land in the prompt as punctuation.
 * Remove the whole report here, where the prefix is still visible.
 *
 * `carry` is the tail of a report split across chunks; feed it back as the second argument on the next chunk.
 */
export function stripLegacyMouseReports(chunk: string, carry = ''): { text: string; carry: string } {
  const input = carry + chunk
  let text = ''
  let index = 0
  while (index < input.length) {
    if (input[index] === '\x1b') {
      const remaining = input.length - index
      if (remaining < X10_START.length) {
        const tail = input.slice(index)
        if (X10_START.startsWith(tail)) return { text, carry: tail }
      } else if (input.startsWith(X10_START, index)) {
        if (remaining < X10_START.length + X10_PAYLOAD) return { text, carry: input.slice(index) }
        index += X10_START.length + X10_PAYLOAD
        continue
      }
    }
    text += input[index]
    index++
  }
  return { text, carry: '' }
}

/**
 * Ink owns the input stream, so a report can only be kept out of `useInput` if it never reaches Ink's reader.
 * Ink 8 reads stdin with `read()`, so the filter wraps that single method: everything that is not an X10 report is
 * forwarded byte for byte and every other stream property (raw mode, TTY flags, event handlers) stays the real one.
 */
export function installLegacyMouseFilter(source: NodeJS.ReadStream): () => void {
  const mutable = source as unknown as { read: (size?: number) => string | null }
  const original = mutable.read.bind(source)
  let carry = ''
  mutable.read = (size?: number) => {
    const chunk = original(size)
    if (chunk === null) return null
    const stripped = stripLegacyMouseReports(String(chunk), carry)
    carry = stripped.carry
    return stripped.text
  }
  return () => {
    mutable.read = original
  }
}
