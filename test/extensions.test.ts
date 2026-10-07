import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { expandCommand } from '../src/commands'
import { buildSystemPrompt } from '../src/context'
import { loadAgentDefs, loadCommands, loadSkills, parseFrontmatter } from '../src/extensions'
import { createSkillTool } from '../src/tools/skill'

function roots() {
  return { cwd: mkdtempSync(join(tmpdir(), 'bx-c-')), home: mkdtempSync(join(tmpdir(), 'bx-h-')), userHome: mkdtempSync(join(tmpdir(), 'bx-u-')) }
}
function put(path: string, text: string) {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text)
}

test('parseFrontmatter reads key: value and [a, b] lists', () => {
  expect(parseFrontmatter('---\nname: x\ntools: [read, grep]\ndescription: "hi: there"\n---\nbody\n')).toEqual({
    data: { name: 'x', tools: ['read', 'grep'], description: 'hi: there' },
    body: 'body\n',
  })
  expect(parseFrontmatter('no front')).toEqual({ data: {}, body: 'no front' })
})

test('skills load from .claude and .bccli, project wins', () => {
  const r = roots()
  put(join(r.userHome, '.claude/skills/pdf/SKILL.md'), '---\nname: pdf\ndescription: global pdf\n---\nG')
  put(join(r.cwd, '.bccli/skills/pdf/SKILL.md'), '---\nname: pdf\ndescription: project pdf\n---\nP')
  put(join(r.home, 'skills/tdd/SKILL.md'), '---\nname: tdd\ndescription: test first\n---\nT')
  const skills = loadSkills(r)
  expect(skills.map((s) => `${s.name}:${s.description}`).sort()).toEqual(['pdf:project pdf', 'tdd:test first'])
})

test('commands and agents load with frontmatter', () => {
  const r = roots()
  put(join(r.cwd, '.claude/commands/review.md'), '---\ndescription: review the diff\nargument-hint: <file>\n---\nReview $ARGUMENTS carefully.')
  put(join(r.home, 'agents/reviewer.md'), '---\nname: reviewer\ndescription: code reviewer\ntools: [read, grep]\nmodel: openrouter/x\nmaxSteps: 7\n---\nYou review code.')
  const [cmd] = loadCommands(r)
  expect(cmd).toEqual({ name: 'review', description: 'review the diff', argumentHint: '<file>', body: 'Review $ARGUMENTS carefully.' })
  expect(expandCommand(cmd, 'a.ts')).toBe('Review a.ts carefully.')
  expect(expandCommand({ name: 'x', body: 'Do it.' }, 'now')).toBe('Do it.\n\nnow')
  expect(loadAgentDefs(r)).toEqual([{ name: 'reviewer', description: 'code reviewer', tools: ['read', 'grep'], model: 'openrouter/x', prompt: 'You review code.', maxSteps: 7 }])
})

test('skill tool returns the skill body with its folder; system prompt lists skills', async () => {
  const r = roots()
  put(join(r.home, 'skills/tdd/SKILL.md'), '---\nname: tdd\ndescription: test first\n---\nWrite the test first.')
  const skills = loadSkills(r)
  const tool = createSkillTool(skills)
  const ctx = { cwd: r.cwd, signal: new AbortController().signal, readFiles: new Set<string>() }
  const out = await tool.run({ name: 'tdd' }, ctx)
  expect(out.output).toContain('Write the test first.')
  expect(out.output).toContain(join(r.home, 'skills/tdd'))
  expect((await tool.run({ name: 'nope' }, ctx)).isError).toBe(true)
  expect(buildSystemPrompt({ cwd: r.cwd, home: r.home, model: 'm', skills })).toContain('- tdd: test first')
})

test('an agent can opt in to parallel execution from the frontmatter', () => {
  const r = roots()
  put(join(r.home, 'agents/fast.md'), '---\ndescription: works alone\nparallel: true\n---\nDo the task.')
  put(join(r.home, 'agents/slow.md'), '---\ndescription: sequential\nparallel: no\n---\nDo the task.')
  const defs = loadAgentDefs(r)
  expect(defs.find((d) => d.name === 'fast')?.parallel).toBe(true)
  expect(defs.find((d) => d.name === 'slow')?.parallel).toBeUndefined()
})
