import type { z } from 'zod'
import type { AgentEvent, AskPermission } from '../agent'
import type { Usage } from '../provider'

export type PermissionKind = 'read' | 'edit' | 'bash' | 'fetch' | 'mcp'

export interface ToolContext {
  cwd: string
  signal: AbortSignal
  /** Absolute paths read in this session; edit/write of existing files require membership. */
  readFiles: Set<string>
  callId?: string
  emit?: (event: AgentEvent) => void
  ask?: AskPermission
  addUsage?: (usage: Usage) => void
  /** A fetch that was answered from cache calls this so it does not count against the per-turn fetch limit. */
  refundFetch?: () => void
  /** Called with the absolute path before a file is written, so the change can be undone. */
  checkpoint?: (absPath: string) => Promise<void>
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
  /** Raw JSON schema sent to the model instead of converting `schema` (used for MCP tools). */
  jsonSchema?: Record<string, unknown>
  outputJsonSchema?: Record<string, unknown>
  target(input: z.infer<S>): string
  preview?(input: z.infer<S>, ctx: ToolContext): Promise<string | undefined>
  /** Cheap pre-check run before asking permission; returns an error message when the call cannot succeed. */
  validate?(input: z.infer<S>, ctx: ToolContext): Promise<string | undefined>
  /** Consecutive calls whose tool returns true here run concurrently. */
  parallelSafe?(input: z.infer<S>): boolean
  /** Internal safety metadata: safe to call from a bounded read-only PTC program. */
  programmaticSafe?: boolean
  run(input: z.infer<S>, ctx: ToolContext): Promise<ToolResult>
}

export function defineTool<S extends z.ZodType>(tool: Tool<S>): Tool<S> {
  return tool
}
