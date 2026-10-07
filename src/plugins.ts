import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { isAbsolute, join } from 'node:path'
import { z } from 'zod'
import { ConfigError, type Config } from './config'
import type { HookEvent } from './hooks'
import { t } from './i18n'
import type { Tool, ToolContext, ToolResult } from './tools/types'

export type PluginPayload = { tool?: string; input?: unknown; output?: string }

/** What a plugin may do at load time. `config` is the read-only view of the loaded config. */
export interface PluginContext {
  cwd: string
  env: NodeJS.ProcessEnv
  config: Readonly<Config>
  registerTool(tool: PluginTool): void
  /** Observe-only in v1: handlers run in order, errors are logged and never break the session. */
  on(event: HookEvent, handler: (payload: PluginPayload) => void | Promise<void>): void
  log(message: string): void
}

/** A tool as declared by a plugin; schema/kind/target get safe defaults. */
export interface PluginTool {
  name: string
  description: string
  schema?: z.ZodType
  kind?: Tool['kind']
  target?: (input: unknown) => string
  run(input: never, ctx: ToolContext): Promise<ToolResult>
}

export interface LoadedPlugins {
  tools: Tool[]
  emit(event: HookEvent, payload?: PluginPayload): Promise<void>
}

const require_ = createRequire(import.meta.url)

function pluginLog(message: string): void {
  process.stderr.write(`[plugin] ${message}\n`)
}

function normalizeTool(def: PluginTool): Tool {
  return {
    name: def.name,
    description: def.description,
    // Raw-args passthrough: a plugin without its own zod still receives what the model sent.
    schema: def.schema ?? z.record(z.string(), z.unknown()),
    kind: def.kind ?? 'read',
    target: (def.target ?? (() => def.name)) as Tool['target'],
    run: def.run as Tool['run'],
  }
}

/**
 * Loads the plugins listed in the global config (trusted). Specs may be absolute paths,
 * `./`-relative to the config home, or bare package specifiers. Every failure — missing
 * file, syntax error, bad activation, name collision — throws ConfigError so a broken
 * plugin is visible immediately instead of silently missing.
 */
export function loadPlugins(
  specs: string[],
  opts: { home: string; cwd: string; env: NodeJS.ProcessEnv; config: Config; builtinNames: string[] },
): LoadedPlugins {
  const tools: Tool[] = []
  const taken = new Set(opts.builtinNames)
  const listeners = new Map<HookEvent, ((payload: PluginPayload) => void | Promise<void>)[]>()

  for (const spec of specs) {
    let file: string
    try {
      file = isAbsolute(spec) ? spec : spec.startsWith('.') ? join(opts.home, spec) : require_.resolve(spec)
    } catch {
      throw new ConfigError(t('Plugin not found: {spec}', { spec }))
    }
    if (!existsSync(file)) throw new ConfigError(t('Plugin not found: {spec}', { spec }))

    let mod: unknown
    try {
      mod = require_(file)
    } catch (error) {
      throw new ConfigError(t('Plugin failed to load: {spec}: {reason}', { spec, reason: (error as Error).message }))
    }
    // ESM: `export default fn` (interop → mod.default) or `export function activate`.
    // CJS: `module.exports = fn` — require_ hands back the function itself.
    const asRecord = (mod ?? {}) as { default?: unknown; activate?: unknown }
    const activate =
      typeof mod === 'function'
        ? mod
        : typeof asRecord.default === 'function'
          ? asRecord.default
          : typeof asRecord.activate === 'function'
            ? asRecord.activate
            : undefined
    if (!activate) {
      throw new ConfigError(
        t('Plugin failed to load: {spec}: {reason}', {
          spec,
          reason: 'no activate function (use export default fn, export function activate, or module.exports = fn)',
        }),
      )
    }

    const ctx: PluginContext = {
      cwd: opts.cwd,
      env: opts.env,
      config: opts.config,
      registerTool(tool: PluginTool) {
        if (taken.has(tool.name)) {
          throw new ConfigError(
            t('Plugin {spec} registered a tool name that is already in use: {name}', { spec, name: tool.name }),
          )
        }
        taken.add(tool.name)
        tools.push(normalizeTool(tool))
      },
      on(event, handler) {
        const list = listeners.get(event) ?? []
        list.push(handler)
        listeners.set(event, list)
      },
      log: pluginLog,
    }

    try {
      const result = (activate as (c: PluginContext) => unknown)(ctx)
      if (result && typeof (result as Promise<void>).catch === 'function') {
        ;(result as Promise<void>).catch((error: unknown) => pluginLog(`activation error in ${spec}: ${String(error)}`))
      }
    } catch (error) {
      throw new ConfigError(t('Plugin failed to load: {spec}: {reason}', { spec, reason: (error as Error).message }))
    }
  }

  return {
    tools,
    async emit(event, payload = {}) {
      for (const handler of listeners.get(event) ?? []) {
        try {
          await handler(payload)
        } catch (error) {
          pluginLog(`handler for ${event} failed: ${String(error)}`)
        }
      }
    },
  }
}
