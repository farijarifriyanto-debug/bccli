import { Text } from 'ink'
import { useEffect, useState } from 'react'
import { ACCENT, color } from './theme'

const FRAMES = ['·', '✢', '✳', '✶', '✻', '✽']

export function Spinner({ label, startedAt }: { label: string; startedAt: number }) {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 120)
    return () => clearInterval(id)
  }, [])
  const seconds = Math.floor((Date.now() - startedAt) / 1000)
  return <Text color={color(ACCENT)}>{`${FRAMES[tick % FRAMES.length]} ${label}… (${seconds} dtk · esc batal)`}</Text>
}
