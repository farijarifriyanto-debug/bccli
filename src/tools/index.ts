import { z } from 'zod'
import { bashTool } from './bash'
import { editTool } from './edit'
import { fetchTool } from './fetch'
import { globTool } from './glob'
import { grepTool } from './grep'
import { readTool } from './read'
import type { Tool } from './types'
import { writeTool } from './write'

export interface ToolDefinition {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown>; output_schema?: Record<string, unknown> }
}

export const ALL_TOOLS: Tool[] = [readTool, writeTool, editTool, bashTool, grepTool, globTool, fetchTool] as Tool[]

export function toolDefinitions(tools: Tool[]): ToolDefinition[] {
  return tools.map((tool) => {
    const { $schema: _ignored, ...parameters } = (tool.jsonSchema ?? z.toJSONSchema(tool.schema)) as Record<string, unknown>
    return { type: 'function', function: { name: tool.name, description: tool.description, parameters, ...(tool.outputJsonSchema ? { output_schema: tool.outputJsonSchema } : {}) } }
  })
}
