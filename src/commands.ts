export const SLASH_COMMANDS = [
  { name: 'help', description: 'daftar perintah dan pintasan' },
  { name: 'model', description: 'ganti model' },
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
