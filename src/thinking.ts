// Some models put their reasoning inside the answer as <think>…</think> instead of a separate field.
// ThinkSplitter routes streamed text in and out of those blocks, holding back a possibly cut tag.

const OPEN = '<think>'
const CLOSE = '</think>'

/** Length of the longest suffix of `text` that is a proper prefix of `tag`. */
function partialTag(text: string, tag: string): number {
  for (let n = Math.min(tag.length - 1, text.length); n > 0; n--) if (tag.startsWith(text.slice(-n))) return n
  return 0
}

export class ThinkSplitter {
  private inside = false
  private held = ''

  push(delta: string): { text: string; thinking: string } {
    let rest = this.held + delta
    this.held = ''
    let text = ''
    let thinking = ''
    while (rest) {
      const tag = this.inside ? CLOSE : OPEN
      const at = rest.indexOf(tag)
      if (at >= 0) {
        if (this.inside) thinking += rest.slice(0, at)
        else text += rest.slice(0, at)
        rest = rest.slice(at + tag.length)
        this.inside = !this.inside
        continue
      }
      const keep = partialTag(rest, tag)
      const out = rest.slice(0, rest.length - keep)
      if (this.inside) thinking += out
      else text += out
      this.held = rest.slice(rest.length - keep)
      break
    }
    return { text, thinking }
  }

  /** Whatever was held back as a possible tag start is plain text after all. */
  flush(): { text: string; thinking: string } {
    const held = this.held
    this.held = ''
    return this.inside ? { text: '', thinking: held } : { text: held, thinking: '' }
  }
}

export function splitThinking(text: string): { text: string; thinking: string } {
  const s = new ThinkSplitter()
  const a = s.push(text)
  const b = s.flush()
  return { text: a.text + b.text, thinking: a.thinking + b.thinking }
}
