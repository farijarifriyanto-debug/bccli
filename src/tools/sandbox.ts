export function sandboxSupported(platform: NodeJS.Platform): boolean {
  return platform === 'darwin' || platform === 'linux'
}

/** Converts a Windows drive path (`C:\Users\foo`) into its WSL `/mnt/c/Users/foo` mount path. */
export function winPathToWsl(winPath: string): string {
  const normalized = winPath.replace(/\\/g, '/')
  const m = /^([A-Za-z]):\/(.*)$/.exec(normalized)
  return m ? `/mnt/${m[1].toLowerCase()}/${m[2]}` : normalized
}

/** Seatbelt profile: read everything, write only under cwd + temp areas, network only when allowed. */
export function darwinProfile(cwd: string, network: boolean): string {
  const writable = [cwd, '/tmp', '/private/tmp', '/dev', '/var/folders'].map((p) => `(subpath "${p}")`).join(' ')
  return [
    '(version 1)',
    '(deny default)',
    '(allow process*)',
    '(allow signal (target self))',
    '(allow sysctl-read)',
    '(allow file-read*)',
    `(allow file-write* ${writable})`,
    '(allow mach-lookup)',
    '(allow ipc-posix*)',
    network ? '(allow network*)' : '(deny network*)',
  ].join('\n')
}

/**
 * One bwrap invocation. The Windows path only prefixes it with `wsl.exe --` and translates
 * the cwd to its /mnt/<drive> form, so the sandbox flags live in exactly one place.
 */
function bwrapArgv(cwd: string, network: boolean, command: string): string[] {
  return [
    'bwrap',
    '--ro-bind',
    '/',
    '/',
    '--dev-bind',
    '/dev',
    '/dev',
    '--proc',
    '/proc',
    '--bind',
    cwd,
    cwd,
    '--tmpfs',
    '/tmp',
    '--die-with-parent',
    ...(network ? [] : ['--unshare-net']),
    '--',
    '/bin/bash',
    '-c',
    command,
  ]
}

/**
 * Wrap a shell command in the platform sandbox, or undefined when the platform has none
 * (the caller then refuses to run it sandboxed rather than silently running it raw).
 */
export function sandboxArgv(
  command: string,
  opts: { platform: NodeJS.Platform; cwd: string; network: boolean; wslBwrap?: boolean },
): string[] | undefined {
  if (opts.platform === 'darwin') {
    return ['sandbox-exec', '-p', darwinProfile(opts.cwd, opts.network), '/bin/bash', '-c', command]
  }
  if (opts.platform === 'linux') {
    return bwrapArgv(opts.cwd, opts.network, command)
  }
  if (opts.platform === 'win32' && (opts.wslBwrap || process.env.BCCLI_WIN32_WSL_SANDBOX === '1')) {
    return ['wsl.exe', '--', ...bwrapArgv(winPathToWsl(opts.cwd), opts.network, command)]
  }
  return undefined
}
