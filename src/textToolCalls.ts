import type { ToolCall } from './provider'
import type { ToolDefinition } from './tools/index'

// Some models behind OpenAI-compatible gateways write their tool calls into the text (GLM-style
// `<tool_call>name<arg_key>k</arg_key><arg_value>v</arg_value></tool_call>`, often mangled, e.g.
// "- `command</arg_key>` = `ls</arg_value>") instead of `tool_calls`. Without this the turn just ends.

const PAIR = /(?:<arg_key>\s*|`)?([A-Za-z_]\w*)(?:\s*<\/arg_key>)?`?\s*(?:=\s*`|<arg_value>)([\s\S]*?)<\/arg_value>/g
const CALL_START = /<tool_call>|\n?[^\n]*\bTool call list\b[^\n]*|\n\s*\d+\.\s*Tool:/g

interface Props {
  properties?: Record<string, { type?: string | string[] }>
  required?: string[]
}

function coerce(value: string, type: string | string[] | undefined): unknown {
  const types = Array.isArray(type) ? type : [type]
  const v = value.trim()
  if ((types.includes('integer') || types.includes('number')) && v !== '' && !Number.isNaN(Number(v))) return Number(v)
  if (types.includes('boolean') && /^(true|false)$/i.test(v)) return v.toLowerCase() === 'true'
  if ((types.includes('object') || types.includes('array')) && /^[[{]/.test(v)) {
    try {
      return JSON.parse(v)
    } catch {}
  }
  return value.replace(/^\n+|\n+$/g, '')
}

/** Picks the tool a call was meant for: the named one if it exists, else the best match on argument names. */
function pickTool(name: string | undefined, keys: string[], tools: ToolDefinition[]): ToolDefinition | undefined {
  const named = name && tools.find((t) => t.function.name === name)
  if (named) return named
  let best: ToolDefinition | undefined
  let bestScore = 0
  let tie = false
  for (const t of tools) {
    const params = t.function.parameters as Props
    const props = Object.keys(params.properties ?? {})
    if (!(params.required ?? []).every((r) => keys.includes(r))) continue
    const score = keys.filter((k) => props.includes(k)).length
    if (score > bestScore) [best, bestScore, tie] = [t, score, false]
    else if (score === bestScore && score > 0) tie = true
  }
  return tie ? undefined : best
}

export function recoverTextToolCalls(text: string, tools: ToolDefinition[]): { text: string; toolCalls: ToolCall[] } | null {
  if (!/<\/arg_value>|<tool_call>/.test(text)) return null
  const starts = [...text.matchAll(CALL_START)].map((m) => m.index ?? 0)
  const firstPair = text.search(PAIR)
  const cut = Math.min(...[...starts, firstPair].filter((i) => i >= 0))
  // One segment per announced call; a repeated argument name also starts a new call.
  const bounds = starts.filter((i) => i >= cut)
  if (!bounds.length || bounds[0] > cut) bounds.unshift(cut)
  const toolCalls: ToolCall[] = []
  bounds.forEach((start, n) => {
    const segment = text.slice(start, bounds[n + 1] ?? text.length)
    const name = /<tool_call>\s*([A-Za-z_][\w.-]*)/.exec(segment)?.[1] ?? /Tool:\s*`?([A-Za-z_][\w.-]*)`?/.exec(segment)?.[1]
    let args: [string, string][] = []
    const flush = () => {
      if (!args.length) return
      const keys = args.map(([k]) => k)
      const tool = pickTool(name, keys, tools)
      if (tool) {
        const props = (tool.function.parameters as Props).properties ?? {}
        const input = Object.fromEntries(args.filter(([k]) => k in props).map(([k, v]) => [k, coerce(v, props[k].type)]))
        toolCalls.push({ id: `text_call_${toolCalls.length}`, name: tool.function.name, arguments: JSON.stringify(input) })
      }
      args = []
    }
    for (const m of segment.matchAll(PAIR)) {
      if (args.some(([k]) => k === m[1])) flush()
      args.push([m[1], m[2]])
    }
    flush()
  })
  if (!toolCalls.length) return null
  return { text: text.slice(0, cut).trim(), toolCalls }
}
