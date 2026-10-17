import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildRepoMapSync, extractSymbols } from '../src/repomap'
import { createRepoMapTool } from '../src/tools/repomap'
import { buildSystemPrompt } from '../src/context'
import { ConfigError, loadConfig } from '../src/config'
import type { ToolContext } from '../src/tools/types'

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), 'bccli-map-'))
  mkdirSync(join(root, 'src'), { recursive: true })
  mkdirSync(join(root, 'node_modules', 'dep'), { recursive: true })
  writeFileSync(join(root, 'src', 'a.ts'), 'export function alpha() {}\nclass Beta {}\n')
  writeFileSync(join(root, 'lib.py'), 'def gamma():\n    pass\n')
  writeFileSync(join(root, 'node_modules', 'dep', 'x.ts'), 'export function hidden() {}\n')
  return root
}

const ctx = (cwd: string): ToolContext => ({ cwd, signal: new AbortController().signal, readFiles: new Set<string>() })

describe('repo map', () => {
  it('lists code files with top-level symbols and skips node_modules', () => {
    const map = buildRepoMapSync(repo())
    expect(map).toContain('alpha')
    expect(map).toContain('Beta')
    expect(map).toContain('gamma')
    expect(map).not.toContain('hidden')
  })

  it('extracts symbols per language', () => {
    expect(extractSymbols('export async function f() {}\ninterface I {}\nconst g = 1\n', '.ts')).toEqual(
      expect.arrayContaining(['f', 'I']),
    )
    expect(extractSymbols('def a():\n    pass\nclass B:\n    pass\n', '.py')).toEqual(['a', 'B'])
    expect(extractSymbols('func (s *S) Do() {}\ntype T struct{}\n', '.go')).toEqual(expect.arrayContaining(['Do', 'T']))
    expect(extractSymbols('pub fn main() {}\nstruct S;\n', '.rs')).toEqual(expect.arrayContaining(['main', 'S']))
  })

  it('truncates to the token budget', () => {
    const root = repo()
    for (let i = 0; i < 40; i++) writeFileSync(join(root, 'src', `f${i}.ts`), `export function fn${i}() {}\n`)
    const map = buildRepoMapSync(root, { maxTokens: 60 })
    expect(map).toContain('truncated')
    expect(map.split('\n').length).toBeLessThan(40)
  })

  it('exposes a repo_map tool', async () => {
    const tool = createRepoMapTool()
    expect(tool.name).toBe('repo_map')
    const r = await tool.run({}, ctx(repo()))
    expect(r.output).toContain('alpha')
    expect(r.isError).toBeFalsy()
  })

  it('injects the map into the system prompt when asked', () => {
    const p = buildSystemPrompt({ cwd: '/x', home: '/h', model: 'm', repoMap: 'MAPTEXT' })
    expect(p).toContain('Repository map')
    expect(p).toContain('MAPTEXT')
  })

  it('rejects a non-boolean repoMap config', () => {
    const home = mkdtempSync(join(tmpdir(), 'bccli-mapcfg-'))
    const project = mkdtempSync(join(tmpdir(), 'bccli-mapproj-'))
    writeFileSync(join(home, 'config.json'), JSON.stringify({ repoMap: 'yes' }))
    expect(() => loadConfig(project, { BCCLI_HOME: home })).toThrow(ConfigError)
  })

  it('defaults repoMap to false', () => {
    const home = mkdtempSync(join(tmpdir(), 'bccli-mapdef-'))
    const project = mkdtempSync(join(tmpdir(), 'bccli-mapdefp-'))
    writeFileSync(join(home, 'config.json'), '{}')
    expect(loadConfig(project, { BCCLI_HOME: home }).repoMap).toBe(false)
  })
})
