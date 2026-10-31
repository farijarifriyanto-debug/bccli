import { Box, Text, useInput } from 'ink'
import { useState } from 'react'
import type { ModelGroup } from '../models'
import { color } from './theme'
import { isControlReportFragment } from './thinkingMouse'
import { t } from '../i18n'

type Row = { kind: 'header'; text: string } | { kind: 'model'; ref: string; label: string }

// Two rows of the box (title, search) are fixed, so the scrolled list takes two fewer rows than a
// plain list would and the picker stays as tall as it was before the search field existed.
const VISIBLE = 12

/** Splits the label at the matched part so the row itself shows why the search kept it. */
function highlight(label: string, needle: string): [string, string, string] {
  const at = needle ? label.toLowerCase().indexOf(needle) : -1
  if (at < 0) return [label, '', '']
  return [label.slice(0, at), label.slice(at, at + needle.length), label.slice(at + needle.length)]
}

export function ModelPicker({ groups, current, onPick }: { groups: ModelGroup[]; current: string; onPick(ref?: string): void }) {
  const [filter, setFilter] = useState('')
  const [index, setIndex] = useState(0)
  const needle = filter.trim().toLowerCase()
  // Two providers can share a display name (gmi and gmicloud are both "GMI Cloud"); the header then
  // carries the id, otherwise the list shows the same heading twice with no way to tell them apart.
  const nameCount = new Map<string, number>()
  for (const g of groups) nameCount.set(g.providerName, (nameCount.get(g.providerName) ?? 0) + 1)
  const rows: Row[] = []
  let available = 0
  for (const g of groups) {
    if (g.error) continue
    available += g.models.length
    // The provider name and id are searchable too: "openrouter" narrows the list to that provider.
    const providerHit = !!needle && `${g.providerName} ${g.providerId}`.toLowerCase().includes(needle)
    const models = providerHit ? g.models : g.models.filter((m) => m.toLowerCase().includes(needle))
    if (!models.length) continue
    rows.push({ kind: 'header', text: (nameCount.get(g.providerName) ?? 0) > 1 ? `${g.providerName} (${g.providerId})` : g.providerName })
    for (const m of models) rows.push({ kind: 'model', ref: `${g.providerId}/${m}`, label: m })
  }
  const selectable = rows.flatMap((r, i) => (r.kind === 'model' ? [i] : []))
  const clampedIndex = Math.min(index, Math.max(0, selectable.length - 1))
  const cursor = selectable[clampedIndex] ?? -1

  useInput((input, key) => {
    if (isControlReportFragment(input)) return
    if (key.upArrow) setIndex(Math.max(0, clampedIndex - 1))
    else if (key.downArrow) setIndex(Math.min(Math.max(0, selectable.length - 1), clampedIndex + 1))
    else if (key.pageUp) setIndex(Math.max(0, clampedIndex - VISIBLE))
    else if (key.pageDown) setIndex(Math.min(Math.max(0, selectable.length - 1), clampedIndex + VISIBLE))
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
      <Box justifyContent="space-between">
        <Text bold>{t('Choose a model')}</Text>
        <Text dimColor>{t('{shown}/{total} models', { shown: selectable.length, total: available })}</Text>
      </Box>
      <Text>
        <Text dimColor>{`${t('search')}: `}</Text>
        <Text color={color('green')}>{filter}</Text>
        <Text color={color('green')}>▌</Text>
        {filter ? null : <Text dimColor>{t('type a model or provider name')}</Text>}
      </Text>
      {rows.slice(start, start + VISIBLE).map((row, i) => {
        if (row.kind === 'header') return <Text key={`h${start + i}`} dimColor>{`── ${row.text} `}</Text>
        const selected = start + i === cursor
        const [before, hit, after] = highlight(row.label, needle)
        return (
          <Text key={row.ref} color={selected ? color('green') : undefined}>
            {`${selected ? '›' : ' '} ${before}`}
            {hit ? <Text bold>{hit}</Text> : null}
            {`${after}${row.ref === current ? '  (aktif)' : ''}`}
          </Text>
        )
      })}
      {selectable.length ? null : <Text dimColor>{t('No matching models.')}</Text>}
      <Text dimColor>{t('↑↓ move · enter choose · esc cancel')}</Text>
      {/* Unreachable providers stay visible below the scrolled list. */}
      {groups
        .filter((g) => g.error)
        .map((g) => (
          <Text key={`e-${g.providerId}`} color={color('yellow')}>{`${g.providerName} — ${g.error}`}</Text>
        ))}
    </Box>
  )
}
