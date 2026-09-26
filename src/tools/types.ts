import type { z } from 'zod'

export type PermissionKind = 'read' | 'edit' | 'bash' | 'fetch'

export interface ToolContext {
  cwd: string
  signal: AbortSignal
  /** Absolute paths read in this session; edit/write of existing files require membership. */
  readFiles: Set<string>
}

export interface ToolResult {
  /** Sent back to the model. */
  output: string
  isError?: boolean
  /** Optional richer text for the UI (e.g. a diff). */
  display?: string
}

export interface Tool<S extends z.ZodType = z.ZodType> {
  name: string
  description: string
  schema: S
  kind: PermissionKind
  target(input: z.infer<S>): string
  preview?(input: z.infer<S>, ctx: ToolContext): Promise<string | undefined>
  /** Cheap pre-check run before asking permission; returns an error message when the call cannot succeed. */
  validate?(input: z.infer<S>, ctx: ToolContext): Promise<string | undefined>
  run(input: z.infer<S>, ctx: ToolContext): Promise<ToolResult>
}

export function defineTool<S extends z.ZodType>(tool: Tool<S>): Tool<S> {
  return tool
}
