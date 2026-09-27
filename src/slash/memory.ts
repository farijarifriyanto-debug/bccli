import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { instructionPaths } from '../context'

export function instructionFiles(cwd: string, home: string): { path: string; lines: number }[] {
  return instructionPaths(cwd, home)
    .filter((path) => existsSync(path))
    .map((path) => ({ path, lines: readFileSync(path, 'utf8').split('\n').filter(Boolean).length }))
}

export function appendMemory(file: string, text: string): void {
  const prefix = existsSync(file) && !readFileSync(file, 'utf8').endsWith('\n') ? '\n' : ''
  appendFileSync(file, `${prefix}- ${text.trim()}\n`)
}
