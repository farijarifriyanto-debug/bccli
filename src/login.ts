export function readSecret(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(prompt)
    const stdin = process.stdin
    if (!stdin.isTTY) {
      let data = ''
      stdin.on('data', (d) => {
        data += d
      })
      stdin.on('end', () => resolve(data.trim()))
      return
    }
    let value = ''
    stdin.setRawMode(true)
    stdin.resume()
    const onData = (buffer: Buffer) => {
      for (const ch of buffer.toString()) {
        if (ch === '\r' || ch === '\n') {
          stdin.setRawMode(false)
          stdin.pause()
          stdin.off('data', onData)
          process.stdout.write('\n')
          resolve(value.trim())
          return
        }
        if (ch === '\u0003') process.exit(130)
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1)
        else value += ch
      }
    }
    stdin.on('data', onData)
  })
}

/** What readLine writes back to the terminal: printable input is visible, control keys are not. */
export function echoFor(ch: string): string | undefined {
  const code = ch.codePointAt(0) ?? 0
  if (code < 32 || code === 127) return undefined
  return ch
}

/** Prompt TANPA masking (kode otorisasi harus terlihat saat di-paste). Ctrl+C -> exit 130. */
export function readLine(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(prompt)
    const stdin = process.stdin
    if (!stdin.isTTY) {
      let data = ''
      stdin.on('data', (d) => {
        data += d
      })
      stdin.on('end', () => resolve(data.trim()))
      return
    }
    let value = ''
    stdin.setRawMode(true)
    stdin.resume()
    const onData = (buffer: Buffer) => {
      for (const ch of buffer.toString()) {
        const code = ch.charCodeAt(0)
        if (code === 13 || code === 10) {
          stdin.setRawMode(false)
          stdin.pause()
          stdin.off('data', onData)
          process.stdout.write('\n')
          resolve(value.trim())
          return
        }
        if (code === 3) process.exit(130) // Ctrl+C
        if (code === 127 || code === 8) {
          // Erase the character on screen too, or the visible line stops matching the value.
          if (value) {
            value = value.slice(0, -1)
            process.stdout.write('\b \b')
          }
          continue
        }
        // Raw mode never echoes: without this the pasted code stays invisible.
        const echo = echoFor(ch)
        if (echo) process.stdout.write(echo)
        value += ch
      }
    }
    stdin.on('data', onData)
  })
}

import type { CliArgs } from './args'
import type { ABORT } from './oauthLogin'
import { removeCredential, saveCredential } from './config'
import { defaultOpen } from './mcp/oauth'
import { t } from './i18n'

export interface LoginDeps {
  out(s: string): void
  err(s: string): void
  env: NodeJS.ProcessEnv
  isTTY: boolean
  open(url: string): void
  readLine(prompt: string): Promise<string | typeof ABORT>
  saveCredential(id: string, key: string): void
  removeCredential(id: string): boolean
  fetch: typeof fetch
  legacyAdd(providerId: string, cwd: string): Promise<number>
}

export function defaultLoginDeps(): LoginDeps {
  return {
    out: (s) => console.log(s),
    err: (s) => console.error(s),
    env: process.env,
    isTTY: process.stdin.isTTY ?? false,
    open: (url) => defaultOpen(new URL(url)),
    readLine,
    saveCredential: (id, key) => saveCredential(id, key, process.env),
    removeCredential: (id) => removeCredential(id, process.env),
    fetch: globalThis.fetch,
    // Wiring NYATA jalur lama: persis runLogin lama (provider add + prompt key).
    legacyAdd: async (providerId, targetCwd) => {
      const { runProviderCommand } = await import('./providerCli')
      const { parseCliArgs: parse } = await import('./args')
      return runProviderCommand(parse(['provider', 'add', providerId]), {
        env: process.env,
        cwd: targetCwd,
        out: (s) => console.log(s),
        err: (s) => console.error(s),
        readSecret,
      })
    },
  }
}

export async function runLogin(providerId: string, cwd: string, args: CliArgs, deps: LoginDeps): Promise<number> {
  // Urutan ketat spec §8 — konflik PALING AWAL (kontrak #6): sebelum open/readLine/save/remove.
  if (args.key && args.logout) {
    deps.err(t('Use either --key or --logout, not both.'))
    return 1
  }
  if (args.logout) {
    if (providerId !== 'openrouter') {
      // Logout OAuth hanya openrouter — tidak pernah diam-diam menghapus credential lain.
      deps.err(
        t('Logout is not supported for {id}; use bccli provider remove {id} to delete its stored key and config.', {
          id: providerId,
        }),
      )
      return 1
    }
    const { runOauthLogout } = await import('./oauthLogin')
    return runOauthLogout({ out: deps.out, err: deps.err, env: deps.env, removeCredential: deps.removeCredential })
  }
  if (args.key) return deps.legacyAdd(providerId, cwd)
  if (providerId === 'openrouter') {
    const { runOauthLogin } = await import('./oauthLogin')
    return runOauthLogin({
      out: deps.out,
      err: deps.err,
      env: deps.env,
      isTTY: deps.isTTY,
      open: deps.open,
      readLine: deps.readLine,
      saveCredential: deps.saveCredential,
      fetch: deps.fetch,
    })
  }
  return deps.legacyAdd(providerId, cwd)
}
