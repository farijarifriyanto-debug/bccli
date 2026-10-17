import { describe, expect, it } from 'vitest'
import { applyVim, type VimKey, type VimMode } from '../src/ui/vim'
import type { LineState } from '../src/ui/lineEdit'

const K = (over: Partial<VimKey> = {}): VimKey => ({
  upArrow: false,
  downArrow: false,
  leftArrow: false,
  rightArrow: false,
  ctrl: false,
  meta: false,
  tab: false,
  escape: false,
  return: false,
  ...over,
})

const s = (value: string, cursor = value.length): LineState => ({ value, cursor })
const n = (st: LineState, mode: VimMode, input: string, key = K(), pending?: string) => applyVim(st, mode, input, key, pending)

describe('vim', () => {
  it('esc switches to normal mode and clamps the cursor', () => {
    const r = n(s('hello'), 'insert', '', K({ escape: true }))
    expect(r.mode).toBe('normal')
    expect(r.state.cursor).toBe(4)
    expect(r.handled).toBe(true)
  })

  it('i and a enter insert mode (a moves one right)', () => {
    expect(n(s('ab', 0), 'normal', 'i').mode).toBe('insert')
    expect(n(s('ab', 0), 'normal', 'i').state.cursor).toBe(0)
    const a = n(s('ab', 0), 'normal', 'a')
    expect(a.mode).toBe('insert')
    expect(a.state.cursor).toBe(1)
  })

  it('A and o/O enter insert at end / new lines', () => {
    const bigA = n(s('ab', 0), 'normal', 'A')
    expect(bigA.state.cursor).toBe(2)
    expect(bigA.mode).toBe('insert')
    const o = n(s('ab', 2), 'normal', 'o')
    expect(o.state.value).toBe('ab\n')
    expect(o.state.cursor).toBe(3)
    const capO = n(s('ab', 2), 'normal', 'O')
    expect(capO.state.value).toBe('\nab')
    expect(capO.state.cursor).toBe(0)
  })

  it('h/l/w/b/0/$ move in normal mode', () => {
    expect(n(s('hello world', 0), 'normal', 'l').state.cursor).toBe(1)
    expect(n(s('hello world', 5), 'normal', 'h').state.cursor).toBe(4)
    expect(n(s('hello world', 0), 'normal', 'w').state.cursor).toBe(6)
    expect(n(s('hello world', 11), 'normal', 'b').state.cursor).toBe(6)
    expect(n(s('hello world', 5), 'normal', '0').state.cursor).toBe(0)
    expect(n(s('hello world', 0), 'normal', '$').state.cursor).toBe(11)
  })

  it('j/k move between lines', () => {
    const down = n(s('one\ntwo', 1), 'normal', 'j')
    expect(down.state.cursor).toBe(5)
    const up = n(s('one\ntwo', 5), 'normal', 'k')
    expect(up.state.cursor).toBe(1)
  })

  it('x deletes the character under the cursor', () => {
    const r = n(s('abc', 1), 'normal', 'x')
    expect(r.state.value).toBe('ac')
    expect(r.state.cursor).toBe(1)
  })

  it('dd deletes the current line, dw deletes to the next word', () => {
    const dd = n(s('one\ntwo', 1), 'normal', 'd')
    expect(dd.pending).toBe('d')
    const dd2 = n(dd.state, 'normal', 'd', K(), 'd')
    expect(dd2.state.value).toBe('two')
    expect(dd2.pending).toBeUndefined()
    const dw = n(s('one two', 0), 'normal', 'w', K(), 'd')
    expect(dw.state.value).toBe('two')
  })

  it('dd on the last line also eats the newline before it', () => {
    const r = n(s('one\ntwo', 5), 'normal', 'd', K(), 'd')
    expect(r.state.value).toBe('one')
  })

  it('swallows printable input in normal mode; arrows/ctrl/meta/enter fall through', () => {
    expect(n(s('a', 0), 'normal', 'z').handled).toBe(true)
    expect(n(s('a', 0), 'normal', '', K({ upArrow: true })).handled).toBe(false)
    expect(n(s('a', 0), 'normal', '', K({ ctrl: true })).handled).toBe(false)
    expect(n(s('a', 0), 'normal', '', K({ return: true })).handled).toBe(false)
  })

  it('does not touch insert-mode typing (except esc)', () => {
    expect(n(s('a', 1), 'insert', 'b').handled).toBe(false)
    expect(n(s('a', 1), 'insert', '', K({ escape: true })).handled).toBe(true)
  })
})
