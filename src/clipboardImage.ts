import { execFile } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'

export interface GrabDeps {
  platform: NodeJS.Platform
  tmpdir: string
  now: Date
  run?(cmd: string, args: string[]): Promise<{ code: number; output: string }>
}

export function clipboardTarget(tmpdir: string, now: Date): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
  return join(tmpdir, `bccli-clipboard-${stamp}.png`)
}

/** Terminals cannot transmit images, so each platform's clipboard tool saves a PNG we can point the model at. */
export function clipboardCommand(platform: NodeJS.Platform, target: string): { cmd: string; args: string[] } | undefined {
  if (platform === 'win32') {
    const escaped = target.replace(/'/g, "''")
    return {
      cmd: 'powershell.exe',
      args: [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Add-Type -AssemblyName System.Drawing; $img = Get-Clipboard -Format Image -ErrorAction SilentlyContinue; if ($img) { $img.Save('${escaped}', [System.Drawing.Imaging.ImageFormat]::Png); 'OK' } else { 'EMPTY' }`,
      ],
    }
  }
  if (platform === 'darwin') {
    return {
      cmd: 'osascript',
      args: [
        '-e', 'try',
        '-e', 'set d to the clipboard as «class PNGf»',
        '-e', `set f to open for access POSIX file "${target}" with write permission`,
        '-e', 'set eof f to 0',
        '-e', 'write d to f',
        '-e', 'close access f',
        '-e', '"OK"',
        '-e', 'on error',
        '-e', '"EMPTY"',
        '-e', 'end try',
      ],
    }
  }
  if (platform === 'linux') {
    return { cmd: 'sh', args: ['-c', `xclip -selection clipboard -t image/png -o > '${target}' 2>/dev/null && echo OK || echo EMPTY`] }
  }
  return undefined
}

const defaultRun = (cmd: string, args: string[]) =>
  new Promise<{ code: number; output: string }>((resolve) => {
    execFile(cmd, args, { timeout: 15_000, windowsHide: true }, (error, stdout) => {
      const code = error ? ((error as { code?: number }).code ?? 1) : 0
      resolve({ code: typeof code === 'number' ? code : 1, output: String(stdout ?? '') })
    })
  })

/** Returns the saved PNG path, or undefined when the clipboard holds no image / the platform is unsupported. */
export async function grabClipboardImage(deps: GrabDeps): Promise<string | undefined> {
  const target = clipboardTarget(deps.tmpdir, deps.now)
  const command = clipboardCommand(deps.platform, target)
  if (!command) return undefined
  const run = deps.run ?? defaultRun
  const r = await run(command.cmd, command.args)
  if (r.code === 0 && r.output.includes('OK') && existsSync(target) && statSync(target).size > 0) return target
  return undefined
}
