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
        if (code === 127 || code === 8) value = value.slice(0, -1)
        else value += ch
      }
    }
    stdin.on('data', onData)
  })
}

export async function runLogin(providerId: string, cwd: string): Promise<number> {
  const { runProviderCommand } = await import('./providerCli')
  const { parseCliArgs } = await import('./args')
  return runProviderCommand(parseCliArgs(['provider', 'add', providerId]), {
    env: process.env,
    cwd,
    out: (s) => console.log(s),
    err: (s) => console.error(s),
    readSecret,
  })
}
