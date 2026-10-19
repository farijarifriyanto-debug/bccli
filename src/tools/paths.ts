import { statSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'

const readMtimes = new WeakMap<Set<string>, Map<string, number>>()

export function resolvePath(cwd: string, path: string): string {
  return isAbsolute(path) ? path : resolve(cwd, path)
}

export function errorCode(error: unknown): string {
  return (error as NodeJS.ErrnoException).code ?? (error as Error).message
}

export function recordFileMtime(readFiles: Set<string>, abs: string): void {
  readFiles.add(abs)
  try {
    let map = readMtimes.get(readFiles)
    if (!map) {
      map = new Map()
      readMtimes.set(readFiles, map)
    }
    map.set(abs, statSync(abs).mtimeMs)
  } catch {
    // ignore missing file
  }
}

export function isFileModifiedSinceRead(readFiles: Set<string>, abs: string): boolean {
  const recorded = readMtimes.get(readFiles)?.get(abs)
  if (recorded === undefined) return false
  try {
    return statSync(abs).mtimeMs > recorded + 50
  } catch {
    return false
  }
}
