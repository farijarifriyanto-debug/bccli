import { render } from 'ink-testing-library'
import { expect, test } from 'vitest'
import { Markdown } from '../../src/ui/Markdown'
import { markdownRowCount } from '../../src/ui/markdownLayout'

// ink-testing-library reports a 100 column terminal, and Markdown leaves 3 columns for its bullet and padding.
const WIDTH = 100 - 3

const SAMPLE = [
  '# 1. Ringkasan temuan',
  '',
  'Audit prompt berfokus pada kejelasan tujuan, kelengkapan konteks, ketiadaan ambiguitas, dan kesesuaian format keluaran yang diminta oleh pengguna.',
  '',
  '| P | Aksi | File | Kenapa sekarang |',
  '|---|---|---|---|',
  '| **P0** | Perbaiki `off` menjadi `{enabled:false}` | `account-api/payg-reasoning.mjs` | Bug aktif: biaya reasoning yang diminta mati tetap terbayar |',
  '| **P1** | Tulis ulang `MAGIC_SYSTEM` | `webapp/server.cjs` | Rasio manfaat dan usaha tertinggi di seluruh repo |',
  '',
  '## 2. Rencana',
  '',
  '- Tahap 0: harness offline tanpa biaya',
  '- Tahap 1: ukur token prompt lama dan baru, lalu bandingkan',
  '  1. jalankan suite yang ada',
  '  2. catat selisih token',
  '',
  '> Catatan: skor 27/27 adalah target rancangan, bukan hasil ukur.',
  '',
  '```ts',
  'const tokens = count(prompt)',
  '```',
  '',
  '---',
  '',
  'Penutup singkat.',
].join('\n')

test('markdownRowCount matches the rows Markdown really draws', () => {
  const { lastFrame } = render(<Markdown text={SAMPLE} />)
  const drawn = (lastFrame() ?? '').split('\n').length
  expect(markdownRowCount(SAMPLE, WIDTH)).toBe(drawn)
})

test('a four column table is counted in the rows its cells wrap into', () => {
  const table = SAMPLE.split('\n').slice(4, 8).join('\n')
  const { lastFrame } = render(<Markdown text={table} />)
  const drawn = (lastFrame() ?? '').split('\n').length
  expect(markdownRowCount(table, WIDTH)).toBe(drawn)
  // The source is 4 lines; the rendered table is taller, which is exactly what the old line count missed.
  expect(drawn).toBeGreaterThan(4)
})
