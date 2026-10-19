import { render } from 'ink-testing-library'
import { expect, test, vi } from 'vitest'
import { ListPicker } from '../../src/ui/ListPicker'

const tick = () => new Promise((r) => setTimeout(r, 40))
const items = [
  { id: 'a', label: 'perbaiki test login', hint: '14 pesan' },
  { id: 'b', label: 'kamu siapa', hint: '4 pesan' },
]

test('picks with arrows and enter, filters by typing, esc cancels', async () => {
  const onPick = vi.fn()
  const { stdin, lastFrame } = render(<ListPicker title="Lanjutkan sesi" items={items} onPick={onPick} />)
  expect(lastFrame()).toContain('› perbaiki test login')
  expect(lastFrame()).toContain('14 pesan')
  await tick()
  stdin.write('\u001B[B')
  await tick()
  expect(lastFrame()).toContain('› kamu siapa')
  stdin.write('\u001B[A')
  await tick()
  stdin.write('siapa')
  await tick()
  expect(lastFrame()).not.toContain('perbaiki')
  stdin.write('\r')
  await tick()
  expect(onPick).toHaveBeenCalledWith('b')
  const other = vi.fn()
  const r = render(<ListPicker title="x" items={items} onPick={other} />)
  await tick()
  r.stdin.write('\u001B')
  await tick()
  expect(other).toHaveBeenCalledWith(undefined)
})

test('ListPicker scrolls with 2-finger touchpad wheel and PageDown/PageUp', async () => {
  const many = Array.from({ length: 20 }, (_, i) => ({ id: `id-${i}`, label: `Item ${i}` }))
  const onPick = vi.fn()
  const { stdin, lastFrame } = render(<ListPicker title="Pilih" items={many} onPick={onPick} />)
  await tick()
  expect(lastFrame()).toContain('› Item 0')
  // Touchpad wheel down
  stdin.write('\x1b[<65;10;10M')
  await tick()
  expect(lastFrame()).toContain('› Item 1')
  // Touchpad wheel up
  stdin.write('\x1b[<64;10;10M')
  await tick()
  expect(lastFrame()).toContain('› Item 0')
  // PageDown jumps down
  stdin.write('\x1b[6~')
  await tick()
  expect(lastFrame()).toContain('› Item 12')
  // PageUp jumps back up
  stdin.write('\x1b[5~')
  await tick()
  expect(lastFrame()).toContain('› Item 0')
})
