import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { t } from './i18n'
import { VERSION } from './version'

const REGISTRY_URL = 'https://registry.npmjs.org/-/package/@botconnector/bccli/dist-tags'
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000

export interface UpdateCache {
  checkedAt: string
  latest?: string
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
  if (!latest || compareVersions(current, latest) >= 0) return undefined
  return t('A new bccli is available: {latest} (you have {current}). Run: bccli update', { latest, current })
}

/** Best-effort registry check with a 24h cache; never throws, never blocks startup for long. */
export async function checkForUpdate(deps: { home: string; fetch: typeof fetch; now: Date; timeoutMs?: number }): Promise<string | undefined> {
  try {
    const cached = readCache(deps.home)
    if (!dueForCheck(cached, deps.now)) return updateNotice(VERSION, cached?.latest)
    const res = await deps.fetch(REGISTRY_URL, { signal: AbortSignal.timeout(deps.timeoutMs ?? 3000) })
    if (!res.ok) return updateNotice(VERSION, cached?.latest)
    const tags = (await res.json()) as Record<string, string>
    const latest = tags[channelFor(VERSION)] ?? tags.latest
    writeCache(deps.home, { checkedAt: deps.now.toISOString(), latest })
    return updateNotice(VERSION, latest)
  } catch {
    return undefined
  }
}

export async function runUpdateCommand(deps: { env: NodeJS.ProcessEnv; spawn?: typeof spawnSync }): Promise<number> {
  const version = deps.env.BCCLI_VERSION_OVERRIDE ?? VERSION
  const spec = `@botconnector/bccli@${channelFor(version)}`
  const spawnFn = deps.spawn ?? spawnSync
  const cmd = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const r = spawnFn(cmd, ['i', '-g', spec], { stdio: 'inherit', env: deps.env })
  return typeof r.status === 'number' ? r.status : 1
}
