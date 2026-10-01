import { Box, Text, useStdout } from 'ink'
import type { ReactNode } from 'react'
import { displayWidth, layoutTable, parseInline, parseTable, type Seg } from './table'
import { ACCENT, color } from './theme'

function segment(seg: Seg, key: number): ReactNode {
  switch (seg.style) {
    case 'bold':
      return (
        <Text key={key} bold>
          {seg.text}
        </Text>
      )
    case 'italic':
      return (
        <Text key={key} italic>
          {seg.text}
        </Text>
      )
    case 'strike':
      return (
        <Text key={key} strikethrough>
          {seg.text}
        </Text>
      )
    case 'link':
      return (
        <Text key={key} underline color={color('cyan')}>
          {seg.text}
        </Text>
      )
    case 'code':
      return (
        <Text key={key} color={color('cyan')}>
          {seg.text}
        </Text>
      )
    case 'dim':
      return (
        <Text key={key} dimColor>
          {seg.text}
        </Text>
      )
    default:
      return seg.text
  }
}

const inline = (line: string): ReactNode[] => parseInline(line).map(segment)

const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/
const RULE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/
const QUOTE = /^\s{0,3}((?:>\s?)+)(.*)$/
const BULLET = /^(\s*)[-*+]\s+(.*)$/
const NUMBERED = /^(\s*)(\d{1,9})[.)]\s+(.*)$/
const BULLETS = ['•', '◦', '▪']
/**
 * The glyph depends on the item's own indentation only. A finished answer is printed line by line while it streams,
 * so each line is drawn on its own and cannot know which items came before it.
 */
const bulletFor = (spaces: number): string => BULLETS[spaces === 0 ? 0 : spaces <= 4 ? 1 : 2]

/**
 * A marker in its own column and the text beside it, so long items wrap under the text, not under the marker.
 * The text column gets an explicit width: left to the flex layout it can overrun the terminal by the marker's width.
 */
function hanging(key: string | number, marker: string, body: ReactNode, width: number, padding = 0): ReactNode {
  const textWidth = Math.max(10, width - padding - displayWidth(marker) - 1)
  return (
    <Box key={key} paddingLeft={padding}>
      <Box flexShrink={0} marginRight={1}>
        <Text dimColor>{marker}</Text>
      </Box>
      <Box width={textWidth} flexShrink={0}>
        <Text>{body}</Text>
      </Box>
    </Box>
  )
}

/**
 * `indent` is how many columns the surrounding UI already uses (a bullet, a border), so tables and rules are
 * sized to what is really left of the terminal width.
 */
export function Markdown({ text, indent = 2 }: { text: string; indent?: number }) {
  const { stdout } = useStdout()
  const width = Math.max(20, (stdout?.columns ?? 80) - indent - 1)
  const lines = text.split('\n')
  const rows: ReactNode[] = []
  let inCode = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.trimStart().startsWith('```')) {
      inCode = !inCode
      continue
    }
    if (inCode) {
      rows.push(
        <Text key={i} color={color('cyan')}>
          {`  ${line}`}
        </Text>,
      )
      continue
    }
    const parsed = parseTable(lines, i)
    if (parsed) {
      layoutTable(parsed.table, width).forEach((tableLine, n) => {
        rows.push(<Text key={`${i}-${n}`}>{tableLine.length ? tableLine.map(segment) : ' '}</Text>)
      })
      i = parsed.end - 1
      continue
    }
    const heading = HEADING.exec(line)
    if (heading) {
      const level = heading[1].length
      rows.push(
        <Text key={i} bold underline={level === 1} color={level <= 2 ? color(ACCENT) : undefined}>
          {parseInline(heading[2]).map((s) => s.text).join('')}
        </Text>,
      )
      continue
    }
    if (RULE.test(line)) {
      rows.push(
        <Text key={i} dimColor>
          {'─'.repeat(Math.min(width, 80))}
        </Text>,
      )
      continue
    }
    const quote = QUOTE.exec(line)
    if (quote) {
      const depth = quote[1].replace(/\s/g, '').length
      rows.push(hanging(i, '▎'.repeat(depth), <Text italic>{inline(quote[2])}</Text>, width))
      continue
    }
    const bullet = BULLET.exec(line)
    if (bullet) {
      const padding = Math.min(bullet[1].replace(/\t/g, '    ').length, 16)
      const task = /^\[([ xX])\]\s+(.*)$/.exec(bullet[2])
      rows.push(
        task
          ? hanging(i, task[1] === ' ' ? '☐' : '☑', inline(task[2]), width, padding)
          : hanging(i, bulletFor(padding), inline(bullet[2]), width, padding),
      )
      continue
    }
    const numbered = NUMBERED.exec(line)
    if (numbered) {
      const padding = Math.min(numbered[1].replace(/\t/g, '    ').length, 16)
      rows.push(hanging(i, `${numbered[2]}.`, inline(numbered[3]), width, padding))
      continue
    }
    rows.push(<Text key={i}>{line ? inline(line) : ' '}</Text>)
  }
  return <Box flexDirection="column">{rows}</Box>
}
