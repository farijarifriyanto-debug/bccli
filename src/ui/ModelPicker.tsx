import { Box, Text, useInput } from 'ink'
import { useState } from 'react'
import type { ModelGroup } from '../models'
import { color } from './theme'

type Row = { kind: 'header'; text: string } | { kind: 'model'; ref: string; label: string }

const VISIBLE = 14

export function ModelPicker({ groups, current, onPick }: { groups: ModelGroup[]; current: string; onPick(ref?: string): void }) {
  const [filter, setFilter] = useState('')
  const [index, setIndex] = useState(0)
  const needle = filter.toLowerCase()
  const rows: Row[] = []
  for (const g of groups) {
    if (g.error) continue
    const models = g.models.filter((m) => m.toLowerCase().includes(needle))
    if (!models.length) continue
    rows.push({ kind: 'header', text: g.providerName })
    for (const m of models) rows.push({ kind: 'model', ref: `${g.providerId}/${m}`, label: m })
  }
  const selectable = rows.flatMap((r, i) => (r.kind === 'model' ? [i] : []))
  const cursor = selectable[Math.min(index, selectable.length - 1)] ?? -1

  useInput((input, key) => {
    if (key.upArrow) setIndex((i) => Math.max(0, i - 1))
    else if (key.downArrow) setIndex((i) => Math.min(selectable.length - 1, i + 1))
    else if (key.return) {
      const row = rows[cursor]
      if (row?.kind === 'model') onPick(row.ref)
    } else if (key.escape) onPick(undefined)
    else if (key.backspace || key.delete) {
      setFilter((f) => f.slice(0, -1))
      setIndex(0)
    } else if (!key.ctrl && !key.meta && !key.tab && input) {
      setFilter((f) => f + input)
      setIndex(0)
    }
  })

  const start = Math.max(0, Math.min(cursor - 5, rows.length - VISIBLE))
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={color('cyan')} paddingX={1}>
      <Text bold>{`Pilih model (ketik untuk menyaring${filter ? `: ${filter}` : ''} · ↑↓ enter · esc batal)`}</Text>
      {rows.slice(start, start + VISIBLE).map((row, i) =>
        row.kind === 'header' ? (
          <Text key={`h${start + i}`} dimColor>{`── ${row.text} `}</Text>
        ) : (
          <Text key={row.ref} color={start + i === cursor ? color('green') : undefined}>
            {`${start + i === cursor ? '›' : ' '} ${row.label}${row.ref === current ? '  (aktif)' : ''}`}
          </Text>
        ),
      )}
      {!selectable.length ? <Text dimColor>Tidak ada model yang cocok.</Text> : null}
      {/* Unreachable providers stay visible below the scrolled list. */}
      {groups
        .filter((g) => g.error)
        .map((g) => (
          <Text key={`e-${g.providerId}`} color={color('yellow')}>{`${g.providerName} — ${g.error}`}</Text>
        ))}
    </Box>
  )
}
