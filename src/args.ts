import { parseArgs } from 'node:util'
import { ConfigError, type PermissionMode } from './config'
import { MODE_ORDER } from './permissions'

export interface CliArgs {
  command: 'run' | 'login' | 'models'
  prompt?: string
  print: boolean
  model?: string
  continue: boolean
  resume: boolean
  allowAll: boolean
  allowedTools: string[]
  permissionMode?: PermissionMode
  help: boolean
  version: boolean
  loginProvider?: string
}

export const HELP_TEXT = `BCCLI — agent AI BotConnector di terminal

Pemakaian:
  bccli [tugas]                 mode interaktif (opsional langsung dengan tugas)
  bccli -p "tugas"              jalankan satu tugas tanpa interaksi (skrip/CI)
  bccli login [provider]        simpan API key (default: bc-cloud)
  bccli models                  daftar model dari provider aktif

Opsi:
  -m, --model <provider/model>  pilih model, contoh bc-cloud/glm-5.3-flash
  -c, --continue                lanjutkan sesi terakhir di folder ini
  -r, --resume                  pilih sesi untuk dilanjutkan
      --allow-all               jalankan semua alat tanpa minta izin
      --allowed-tools <a,b>     alat yang boleh tanpa izin: bash, edit, fetch
      --permission-mode <mode>  default | acceptEdits | plan | allowAll
  -v, --version                 versi
  -h, --help                    bantuan ini`

export function parseCliArgs(argv: string[]): CliArgs {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      print: { type: 'boolean', short: 'p' },
      model: { type: 'string', short: 'm' },
      continue: { type: 'boolean', short: 'c' },
      resume: { type: 'boolean', short: 'r' },
      'allow-all': { type: 'boolean' },
      'allowed-tools': { type: 'string' },
      'permission-mode': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  })
  const mode = values['permission-mode']
  if (mode && !MODE_ORDER.includes(mode as PermissionMode)) {
    throw new ConfigError(`--permission-mode harus salah satu dari: ${MODE_ORDER.join(', ')}`)
  }
  const [first, ...rest] = positionals
  const command = first === 'login' || first === 'models' ? first : 'run'
  const words = command === 'run' ? positionals : rest
  return {
    command,
    prompt: command === 'run' && words.length ? words.join(' ') : undefined,
    print: !!values.print,
    model: values.model,
    continue: !!values.continue,
    resume: !!values.resume,
    allowAll: !!values['allow-all'],
    allowedTools: (values['allowed-tools'] ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    permissionMode: mode as PermissionMode | undefined,
    help: !!values.help,
    version: !!values.version,
    loginProvider: command === 'login' ? (rest[0] ?? 'bc-cloud') : undefined,
  }
}
