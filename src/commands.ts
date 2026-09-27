import type { CommandDef } from './extensions'

export const SLASH_COMMANDS = [
  { name: 'help', description: 'daftar perintah dan pintasan' },
  { name: 'model', description: 'ganti model' },
  { name: 'provider', description: 'tambah/pilih provider AI' },
  { name: 'mcp', description: 'pasang/kelola server MCP' },
  { name: 'clear', description: 'mulai percakapan baru' },
  { name: 'compact', description: 'ringkas percakapan' },
  { name: 'cost', description: 'pemakaian token sesi ini' },
  { name: 'exit', description: 'keluar' },
]

export function parseSlash(text: string): { name: string; args: string } | undefined {
  if (!text.startsWith('/')) return undefined
  const [name, ...rest] = text.slice(1).trim().split(/\s+/)
  return { name: name.toLowerCase(), args: rest.join(' ') }
}

export function expandCommand(def: CommandDef, args: string): string {
  if (def.body.includes('$ARGUMENTS')) return def.body.replaceAll('$ARGUMENTS', args)
  return args ? `${def.body}\n\n${args}` : def.body
}
