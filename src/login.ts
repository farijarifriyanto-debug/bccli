import { loadConfig, saveCredential } from './config'
import { createProvider } from './provider'

function readSecret(prompt: string): Promise<string> {
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

export async function runLogin(providerId: string, cwd: string): Promise<number> {
  const config = loadConfig(cwd)
  const provider = config.providers[providerId]
  if (!provider) {
    console.error(`Provider "${providerId}" tidak ada. Tersedia: ${Object.keys(config.providers).join(', ')}`)
    return 1
  }
  const key = await readSecret(`API key untuk ${providerId} (${provider.baseURL}): `)
  if (!key) {
    console.error('API key kosong, tidak disimpan.')
    return 1
  }
  try {
    const models = await createProvider({ baseURL: provider.baseURL.replace(/\/+$/, ''), apiKey: key, model: '' }).listModels()
    saveCredential(providerId, key)
    console.log(`Tersimpan. ${models.length} model tersedia di ${providerId}.`)
    return 0
  } catch (error) {
    console.error(`API key ditolak atau provider tidak bisa dihubungi: ${(error as Error).message}`)
    return 1
  }
}
