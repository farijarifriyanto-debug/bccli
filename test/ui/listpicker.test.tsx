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
