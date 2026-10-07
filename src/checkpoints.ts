import { existsSync, statSync } from 'node:fs'
import { readFile, rm, writeFile } from 'node:fs/promises'

const MAX_TURNS = 20
const MAX_BYTES = 2 * 1024 * 1024

// Original content per file for one agent turn; null = the file did not exist; 'skipped' = too big to keep.
type Turn = Map<string, Buffer | null | 'skipped'>

interface UndoResult {
  restored: string[]
  deleted: string[]
  skipped: string[]
  failed: string[]
}

function emptyResult(): UndoResult {
  return { restored: [], deleted: [], skipped: [], failed: [] }
}

async function restoreTurn(turn: Turn, result: UndoResult): Promise<void> {
  for (const [path, original] of turn) {
    try {
      if (original === 'skipped') result.skipped.push(path)
      else if (original === null) {
        await rm(path, { force: true })
        result.deleted.push(path)
      } else {
        await writeFile(path, original)
        result.restored.push(path)
      }
    } catch {
      // One locked/moved file must not cost the rest of the turn's undo.
      result.failed.push(path)
    }
  }
}

export class CheckpointStore {
  private readonly history: Turn[] = []
  private current: Turn | undefined
  private pendingRedo: Turn | undefined

  beginTurn(): void {
    if (this.current?.size === 0) return
    this.current = new Map()
    this.history.push(this.current)
    this.pendingRedo = undefined
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

  /** Total entries including empty ones; used to align file snapshots with conversation turns. */
  entries(): number {
    return this.history.length
  }

  async undo(): Promise<UndoResult | undefined> {
    while (this.history.length && !this.history.at(-1)?.size) this.history.pop()
    const turn = this.history.pop()
    this.current = undefined
    if (!turn) return undefined
    const result = emptyResult()
    const redo = new Map<string, Buffer | null | 'skipped'>()
    await this.captureFor(turn, redo)
    await restoreTurn(turn, result)
    this.pendingRedo = redo
    return result
  }

  /**
   * Revert every snapshot taken at or after the `keep`-th entry, newest first, so the files
   * end in the state from before the turn that created entry `keep`. Used by /rewind, which
   * pairs conversation turns with the entry count recorded when each turn started.
   */
  async undoTo(keep: number): Promise<UndoResult | undefined> {
    const target = Math.max(0, Math.min(keep, this.history.length))
    const result = emptyResult()
    const redo = new Map<string, Buffer | null | 'skipped'>()
    let applied = false
    while (this.history.length > target) {
      const turn = this.history.pop()
      if (turn?.size) {
        await this.captureFor(turn, redo)
        await restoreTurn(turn, result)
        applied = true
      }
    }
    this.current = undefined
    this.pendingRedo = applied ? redo : undefined
    return applied ? result : undefined
  }

  /**
   * Re-apply the file state captured right before the last undo/undoTo.
   * Only file edits are redone, never conversation history. Invalidated by
   * any new snapshot turn or clear(), so redo can't resurrect stale content.
   */
  async redo(): Promise<UndoResult | undefined> {
    const turn = this.pendingRedo
    if (!turn) return undefined
    this.pendingRedo = undefined
    const result = emptyResult()
    await restoreTurn(turn, result)
    return result
  }

  /** Records the on-disk state of a turn's paths so redo() can put it back. */
  private async captureFor(turn: Turn, into: Turn): Promise<void> {
    for (const [path, original] of turn) {
      if (into.has(path)) continue
      if (original === 'skipped') {
        into.set(path, 'skipped')
        continue
      }
      try {
        if (!existsSync(path)) into.set(path, null)
        else if (statSync(path).size > MAX_BYTES) into.set(path, 'skipped')
        else into.set(path, await readFile(path))
      } catch {
        into.set(path, 'skipped')
      }
    }
  }

  clear(): void {
    this.history.length = 0
    this.current = undefined
    this.pendingRedo = undefined
  }
}
