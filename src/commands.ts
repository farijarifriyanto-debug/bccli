import type { CommandDef } from './extensions'

export const SLASH_COMMANDS = [
  { name: 'help', description: 'daftar perintah dan pintasan' },
  { name: 'model', description: 'ganti model' },
  { name: 'provider', description: 'tambah/pilih provider AI' },
  { name: 'mcp', description: 'pasang/kelola server MCP' },
  { name: 'new', description: 'sesi baru (sesi lama tetap tersimpan)' },
  { name: 'resume', description: 'lanjutkan sesi lain di folder ini' },
  { name: 'session', description: 'info sesi ini' },
  { name: 'status', description: 'versi, model, mode izin, MCP, konteks' },
  { name: 'permissions', description: 'lihat/cabut izin' },
  { name: 'undo', description: 'batalkan edit file giliran terakhir' },
  { name: 'diff', description: 'git diff project' },
  { name: 'copy', description: 'salin jawaban terakhir' },
  { name: 'export', description: 'simpan percakapan ke markdown' },
  { name: 'memory', description: 'instruksi project (/memory <teks>, /memory global <teks>)' },
  { name: 'init', description: 'buat/perbarui AGENTS.md untuk project ini' },
  { name: 'agents', description: 'daftar subagent' },
  { name: 'skills', description: 'daftar skill dan perintah custom' },
  { name: 'doctor', description: 'cek kesehatan instalasi' },
  { name: 'login', description: 'simpan API key provider aktif' },
  { name: 'logout', description: 'hapus API key provider aktif' },
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
