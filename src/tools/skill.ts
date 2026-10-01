import { readFileSync } from 'node:fs'
import { z } from 'zod'
import { parseFrontmatter, type SkillDef } from '../extensions'
import { defineTool, type Tool } from './types'

export function createSkillTool(skills: SkillDef[]): Tool {
  return defineTool({
    name: 'skill',
    description: 'Load a skill (instructions for a kind of task) by name. Use it when a listed skill matches the task, then follow it.',
    schema: z.object({ name: z.string().describe('Skill name from the list in the system prompt') }),
    kind: 'read',
    target: (input) => input.name,
    async run(input) {
      const skill = skills.find((s) => s.name === input.name)
      if (!skill) return { output: `Skill "${input.name}" does not exist. Available: ${skills.map((s) => s.name).join(', ') || '(none)'}`, isError: true }
      const { body } = parseFrontmatter(readFileSync(skill.file, 'utf8'))
      return { output: `Base directory for this skill: ${skill.dir}\n\n${body}`, display: skill.description.slice(0, 60) }
    },
  }) as Tool
}
