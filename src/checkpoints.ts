import { existsSync, statSync } from 'node:fs'
import { readFile, rm, writeFile } from 'node:fs/promises'

const MAX_TURNS = 20
const MAX_BYTES = 2 * 1024 * 1024

// Original content per file for one agent turn; null = the file did not exist; 'skipped' = too big to keep.
type Turn = Map<string, Buffer | null | 'skipped'>

export class CheckpointStore {
  private readonly history: Turn[] = []
  private current: Turn | undefined

  beginTurn(): void {
    if (this.current?.size === 0) return
    this.current = new Map()
    this.history.push(this.current)
  }

  /** Call before writing a file; only the first snapshot per file per turn is kept. */
  async snapshot(path: string): Promise<void> {
    if (!this.current) this.beginTurn()
    const turn = this.current as Turn
    if (turn.has(path)) return
    if (!existsSync(path)) turn.set(path, null)
    else if (statSync(path).size > MAX_BYTES) turn.set(path, 'skipped')
    else turn.set(path, await readFile(path))
    while (this.turns() > MAX_TURNS) this.history.shift()
  }

  turns(): number {
    return this.history.filter((t) => t.size).length
  }

  async undo(): Promise<{ restored: string[]; deleted: string[]; skipped: string[] } | undefined> {
    while (this.history.length && !this.history.at(-1)?.size) this.history.pop()
    const turn = this.history.pop()
    this.current = undefined
    if (!turn) return undefined
    const result = { restored: [] as string[], deleted: [] as string[], skipped: [] as string[] }
    for (const [path, original] of turn) {
      if (original === 'skipped') result.skipped.push(path)
      else if (original === null) {
        await rm(path, { force: true })
        result.deleted.push(path)
      } else {
        await writeFile(path, original)
        result.restored.push(path)
      }
    }
    return result
  }

  clear(): void {
    this.history.length = 0
    this.current = undefined
  }
}
