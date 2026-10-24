import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join } from 'node:path'
import type { CliArgs } from './args'
import { bccliHome, globalConfigPath } from './config'
import { t } from './i18n'
import { type ParsedSpec, isManagedEntry, managedEntry, managedEntryName, parseNpmSpec } from './pluginSpec'

export interface PluginsDeps {
  out(s: string): void
  err(s: string): void
  env: NodeJS.ProcessEnv
  /** argv = argumen setelah npm (mis. ['install','foo']). Prefix = <home>/plugins. */
  runNpm(prefix: string, argv: string[]): Promise<{ code: number; stderr: string }>
  readPlugins(): string[]
  savePlugins(entries: string[]): void
}

/** Minimal package.json so `npm install --prefix` behaves deterministically. */
export function ensurePrefixDir(prefix: string): void {
  mkdirSync(prefix, { recursive: true })
  const pkg = join(prefix, 'package.json')
  if (!existsSync(pkg)) {
    writeFileSync(pkg, `${JSON.stringify({ name: 'bccli-plugins', private: true, version: '0.0.0' }, null, 2)}\n`)
  }
}

export async function runPluginsCommand(args: CliArgs, deps: PluginsDeps): Promise<number> {
  const [action, target] = args.subArgs
  // Revisi #1: home SELALU via bccliHome(deps.env) — tanpa env → ~/.bccli, bukan ''.
  const prefix = join(bccliHome(deps.env), 'plugins')
  switch (action ?? 'list') {
    case 'list':
      return listAction(deps)
    case 'install':
      return installAction(target, deps, prefix)
    case 'remove':
      return removeAction(target, deps, prefix)
    case 'update':
      return updateAction(target, deps, prefix)
    default:
      deps.err(t('Unknown action: {action}. Use list, install <spec>, remove <name>, or update [name].', { action: action ?? '' }))
      return 1
  }
}

// Revisi #3: resolusi list SEJALUR dengan loadPlugins — tanpa import/eksekusi plugin.
const require_ = createRequire(import.meta.url) // base identik dgn dist/plugins.ts

function resolveEntryPath(entry: string, home: string): string | null {
  if (isAbsolute(entry)) return entry
  if (entry.startsWith('.')) return join(home, entry)
  try {
    return require_.resolve(entry) // bare spec — fail → null (unresolved), do not throw
  } catch {
    return null
  }
}

function readFailure(action: 'list' | 'remove' | 'update', error: Error, deps: PluginsDeps): number {
  // Tahap SEBELUM npm: tidak ada perubahan apa pun.
  deps.err(
    t('Cannot read the plugin config while running {action}: {reason} at {path} — no changes were made; fix the config, then retry.', {
      action,
      reason: error.message,
      path: globalConfigPath(deps.env),
    }),
  )
  return 1
}

function listAction(deps: PluginsDeps): number {
  let entries: string[]
  try {
    entries = deps.readPlugins()
  } catch (error) {
    return readFailure('list', error as Error, deps)
  }
  if (!entries.length) {
    deps.out(t('No plugins are installed. Install one with: bccli plugins install <spec>'))
    return 0
  }
  const home = bccliHome(deps.env)
  for (const entry of entries) {
    const managed = isManagedEntry(entry)
    const bare = managed ? managedEntryName(entry) : entry
    const suffix = !managed ? ' (manual)' : bare === null ? ' (malformed)' : ''
    const resolved = resolveEntryPath(entry, home)
    if (!resolved || !existsSync(resolved)) {
      deps.out(`✗ ${entry}${suffix}`)
      continue
    }
    let version = ''
    try {
      const pkgPath = statSync(resolved).isDirectory() ? join(resolved, 'package.json') : join(dirname(resolved), 'package.json')
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string }
      if (pkg.version) version = ` (${pkg.version})`
    } catch {
      // version is informational only
    }
    deps.out(`✓ ${entry}${suffix}${version}`)
  }
  return 0
}

function npmFailure(res: { code: number; stderr: string }, deps: PluginsDeps): number {
  deps.err(t('npm install failed ({code}): {stderr}', { code: String(res.code), stderr: res.stderr.slice(-400) }))
  return 1
}

async function installAction(target: string | undefined, deps: PluginsDeps, prefix: string): Promise<number> {
  if (!target) {
    deps.err(t('install requires a package spec: bccli plugins install <spec>'))
    return 1
  }
  const parsed: ParsedSpec | null = parseNpmSpec(target)
  if (!parsed) {
    deps.err(
      t('Invalid npm package spec: {spec}. Use a name, @scope/name, name@version, or name@tag — URLs, git, paths, and flags are not accepted.', { spec: target }),
    )
    return 1
  }
  ensurePrefixDir(prefix)
  const res = await deps.runNpm(prefix, ['install', parsed.spec])
  if (res.code !== 0) return npmFailure(res, deps)
  const entry = managedEntry(parsed.name)
  let entries: string[]
  try {
    entries = deps.readPlugins()
  } catch (error) {
    // Tahap SESUDAH npm install: file sudah terpasang, entry list tidak berubah.
    deps.err(t('npm finished but the config could not be read: {reason} — the entry list is unchanged; fix {path}, then rerun the same command (safe to repeat).', { reason: (error as Error).message, path: globalConfigPath(deps.env) }))
    return 1
  }
  const wasRegistered = entries.includes(entry)
  try {
    // Aturan 2: includes-sebelum-append → duplikat mustahil; entry lama ditulis identik.
    deps.savePlugins(wasRegistered ? entries : [...entries, entry])
  } catch (error) {
    const reason = (error as Error).message
    // Aturan 4: dua PESAN BERBEDA untuk dua transisi (jangan disatukan).
    deps.err(
      wasRegistered
        ? t('npm finished but the config update failed: {reason}. {name} stays enabled through its existing entry {entry}; the package files may already be new. Fix the config error at {path} — no entry change was required.', { reason, name: parsed.name, entry, path: globalConfigPath(deps.env) })
        : t('npm finished but the config update failed: {reason}. {name} is installed but NOT enabled — fix the config error, then run "bccli plugins install {name}" again (safe to repeat), or add {entry} to {path} manually.', { reason, name: parsed.name, entry, path: globalConfigPath(deps.env) }),
    )
    return 1
  }
  deps.out(wasRegistered ? t('{name} is already enabled.', { name: parsed.name }) : t('{name} installed and enabled.', { name: parsed.name }))
  return 0
}

function resolveTarget(
  target: string | undefined,
  deps: PluginsDeps,
  action: 'remove' | 'update',
): { entry: string; name: string } | { error: string } | 'missing-arg' {
  if (!target) return 'missing-arg'
  let entries: string[]
  try {
    entries = deps.readPlugins()
  } catch (error) {
    // Tahap SEBELUM npm — tidak ada perubahan apa pun.
    return {
      error: t('Cannot read the plugin config while running {action}: {reason} at {path} — no changes were made; fix the config, then retry.', {
        action,
        reason: (error as Error).message,
        path: globalConfigPath(deps.env),
      }),
    }
  }
  if (entries.includes(target)) {
    if (isManagedEntry(target)) {
      const name = managedEntryName(target)
      if (!name) {
        // Revisi #2: entry malformed TIDAK PERNAH diteruskan ke npm.
        return {
          error: t('Malformed managed entry: {entry} — fix it manually in {path}; bccli will not pass it to npm.', {
            entry: target,
            path: globalConfigPath(deps.env),
          }),
        }
      }
      return { entry: target, name }
    }
    return { error: t('{entry} is a manual plugin entry — edit the global config.json directly to remove it.', { entry: target }) }
  }
  const parsed = parseNpmSpec(target)
  if (parsed) {
    const entry = managedEntry(parsed.name)
    if (entries.includes(entry)) return { entry, name: parsed.name }
    return { error: t('{name} is not an installed managed plugin.', { name: parsed.name }) }
  }
  return { error: t('Unknown plugin: {arg}.', { arg: target }) }
}

async function removeAction(target: string | undefined, deps: PluginsDeps, prefix: string): Promise<number> {
  const r = resolveTarget(target, deps, 'remove')
  if (r === 'missing-arg') {
    deps.err(t('remove requires a plugin name: bccli plugins remove <name>'))
    return 1
  }
  if ('error' in r) {
    deps.err(r.error)
    return 1
  }
  const res = await deps.runNpm(prefix, ['uninstall', r.name])
  if (res.code !== 0) return npmFailure(res, deps)
  let next: string[]
  try {
    // Tahap SESUDAH npm: baca gagal → file sudah hilang, entry tidak berubah.
    next = deps.readPlugins().filter((e) => e !== r.entry)
  } catch (error) {
    deps.err(
      t('npm removed the files of {name} but the plugin config could not be read: {reason} — the entry list is unchanged; fix {path}, then run "bccli plugins remove {name}" again (safe to repeat).', {
        name: r.name,
        reason: (error as Error).message,
        path: globalConfigPath(deps.env),
      }),
    )
    return 1
  }
  try {
    deps.savePlugins(next)
  } catch (error) {
    // Aturan 4 transisi 3: file hilang, entry tertinggal → loader gagal start.
    deps.err(
      t('npm removed the files of {name} but the config entry {entry} remains: {reason}. bccli will refuse to start while that entry is listed — fix the config error at {path}, then run "bccli plugins remove {name}" again (safe to repeat), or delete the entry manually.', {
        name: r.name,
        entry: r.entry,
        reason: (error as Error).message,
        path: globalConfigPath(deps.env),
      }),
    )
    return 1
  }
  deps.out(t('{name} removed.', { name: r.name }))
  return 0
}

async function updateAction(target: string | undefined, deps: PluginsDeps, prefix: string): Promise<number> {
  // Aturan 5: sumber iterasi = entries di config, bukan scan direktori; config tidak ditulis.
  // Tahap baca update = SEBELUM npm (tidak pernah menulis).
  let names: string[]
  let hadMalformed = false
  if (target === undefined) {
    let entries: string[]
    try {
      entries = deps.readPlugins()
    } catch (error) {
      return readFailure('update', error as Error, deps)
    }
    names = []
    for (const entry of entries) {
      if (!isManagedEntry(entry)) continue
      const name = managedEntryName(entry)
      if (name) names.push(name)
      else {
        // Revisi #2/#7: malformed dilewati + peringatan, tidak pernah masuk argv npm.
        hadMalformed = true
        deps.err(t('Skipping malformed entry: {entry} — fix it manually in {path}.', { entry, path: globalConfigPath(deps.env) }))
      }
    }
    if (!names.length) {
      if (!hadMalformed) deps.out(t('No managed plugins to update.'))
      return hadMalformed ? 1 : 0
    }
  } else {
    const r = resolveTarget(target, deps, 'update')
    if (r === 'missing-arg') {
      deps.err(t('update requires a plugin name or no argument: bccli plugins update [name]'))
      return 1
    }
    if ('error' in r) {
      deps.err(r.error)
      return 1
    }
    names = [r.name]
  }
  ensurePrefixDir(prefix)
  let failed = false
  for (const name of names) {
    const argv = ['install', `${name}@latest`]
    const res = await deps.runNpm(prefix, argv)
    if (res.code !== 0) {
      failed = true
      deps.err(t('npm install failed ({code}): {stderr}', { code: String(res.code), stderr: res.stderr.slice(-400) }))
    } else {
      deps.out(t('{name} updated to latest.', { name }))
    }
  }
  // Exit 1 bila ada npm gagal ATAU ada entry malformed yang dilewati (config perlu dibereskan).
  return failed || hadMalformed ? 1 : 0
}
