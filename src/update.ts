import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { t } from './i18n'
import { VERSION } from './version'

const REGISTRY_URL = 'https://registry.npmjs.org/-/package/@botconnector/bccli/dist-tags'
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000

export interface UpdateCache {
  checkedAt: string
  latest?: string
  notified?: string
}

function splitVersion(v: string): { core: number[]; pre: string[] } {
  const i = v.indexOf('-')
  const coreStr = i < 0 ? v : v.slice(0, i)
  const preStr = i < 0 ? '' : v.slice(i + 1)
  return {
    core: coreStr.split('.').map((p) => Number.parseInt(p, 10) || 0),
    pre: preStr ? preStr.split('.') : [],
  }
}

/** Simplified semver: numeric cores, prerelease sorts below release, numeric prerelease parts compare numerically. */
export function compareVersions(a: string, b: string): number {
  const A = splitVersion(a)
  const B = splitVersion(b)
  for (let i = 0; i < Math.max(A.core.length, B.core.length); i++) {
    const x = A.core[i] ?? 0
    const y = B.core[i] ?? 0
    if (x !== y) return x < y ? -1 : 1
  }
  if (!A.pre.length && !B.pre.length) return 0
  if (!A.pre.length) return 1
  if (!B.pre.length) return -1
  for (let i = 0; i < Math.max(A.pre.length, B.pre.length); i++) {
    const x = A.pre[i]
    const y = B.pre[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const nx = Number.parseInt(x, 10)
    const ny = Number.parseInt(y, 10)
    if (String(nx) === x && String(ny) === y) {
      if (nx !== ny) return nx < ny ? -1 : 1
    } else if (x !== y) {
      return x < y ? -1 : 1
    }
  }
  return 0
}

export function channelFor(version: string): 'next' | 'latest' {
  return version.includes('-') ? 'next' : 'latest'
}

function cachePath(home: string): string {
  return join(home, 'update-check.json')
}

function readCache(home: string): UpdateCache | undefined {
  try {
    const parsed = JSON.parse(readFileSync(cachePath(home), 'utf8')) as UpdateCache
    return typeof parsed?.checkedAt === 'string' ? parsed : undefined
  } catch {
    return undefined
  }
}

function writeCache(home: string, cache: UpdateCache): void {
  mkdirSync(home, { recursive: true })
  const tmp = `${cachePath(home)}.tmp`
  writeFileSync(tmp, JSON.stringify(cache))
  renameSync(tmp, cachePath(home))
}

export function dueForCheck(cache: UpdateCache | undefined, now: Date, intervalMs = CHECK_INTERVAL_MS): boolean {
  if (!cache) return true
  const at = Date.parse(cache.checkedAt)
  if (!Number.isFinite(at)) return true
  return now.getTime() - at >= intervalMs
}

export function updateNotice(current: string, latest: string | undefined): string | undefined {
  // Registry/cache content is external data. Never render arbitrary escape codes
  // or unbounded text in the operator's terminal.
  if (!latest || latest.length > 64 || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(latest) || compareVersions(current, latest) >= 0) return undefined
  return t('A new bccli is available: {latest} (you have {current}). Run: bccli update', { latest, current })
}

function notifyOnce(home: string, cache: UpdateCache | undefined): string | undefined {
  const message = updateNotice(VERSION, cache?.latest)
  if (!message || !cache?.latest || cache.notified === cache.latest) return undefined
  // Acknowledgement belongs to this exact release, not the notification time.
  // Notification is embedded into the Ink transcript; no stderr flash before UI.
  writeCache(home, { ...cache, notified: cache.latest })
  return message
}

/** Best-effort registry check with a 24h cache; never throws, never blocks startup for long. */
export async function checkForUpdate(deps: { home: string; fetch: typeof fetch; now: Date; timeoutMs?: number }): Promise<string | undefined> {
  try {
    const cached = readCache(deps.home)
    if (!dueForCheck(cached, deps.now)) return notifyOnce(deps.home, cached)
    const res = await deps.fetch(REGISTRY_URL, { signal: AbortSignal.timeout(deps.timeoutMs ?? 3000) })
    if (!res.ok) return notifyOnce(deps.home, cached)
    const tags = (await res.json()) as Record<string, string>
    const latest = tags[channelFor(VERSION)] ?? tags.latest
    const updated: UpdateCache = { checkedAt: deps.now.toISOString(), latest, notified: cached?.notified }
    writeCache(deps.home, updated)
    return notifyOnce(deps.home, updated)
  } catch {
    return undefined
  }
}

export function updateSpawnCommand(
  version: string,
  platform: NodeJS.Platform = process.platform,
  nodeExecPath: string = process.execPath,
): { command: string; args: string[]; npmCli?: string } {
  const spec = `@botconnector/bccli@${channelFor(version)}`
  if (platform !== 'win32') return { command: 'npm', args: ['i', '-g', spec] }
  // Node 24+ does not permit direct spawnSync('npm.cmd') on Windows (EINVAL).
  // Execute the npm JS entrypoint using this Node executable without a shell.
  const npmCli = join(dirname(nodeExecPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  return { command: nodeExecPath, args: [npmCli, 'i', '-g', spec], npmCli }
}

export async function runUpdateCommand(deps: {
  env: NodeJS.ProcessEnv
  spawn?: typeof spawnSync
  platform?: NodeJS.Platform
  nodeExecPath?: string
}): Promise<number> {
  const spec = updateSpawnCommand(deps.env.BCCLI_VERSION_OVERRIDE ?? VERSION, deps.platform, deps.nodeExecPath)
  if (spec.npmCli && !existsSync(spec.npmCli)) {
    console.error(`npm CLI was not found at ${spec.npmCli}. Update manually with: npm install -g @botconnector/bccli@${channelFor(deps.env.BCCLI_VERSION_OVERRIDE ?? VERSION)}`)
    return 1
  }
  const r = (deps.spawn ?? spawnSync)(spec.command, spec.args, { stdio: 'inherit', env: deps.env, shell: false })
  if (r.error) console.error(`BCCLI update failed: ${r.error.message}. Try: npm install -g @botconnector/bccli@${channelFor(deps.env.BCCLI_VERSION_OVERRIDE ?? VERSION)}`)
  return typeof r.status === 'number' ? r.status : 1
}
