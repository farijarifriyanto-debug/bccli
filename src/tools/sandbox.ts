export function sandboxSupported(platform: NodeJS.Platform): boolean {
  return platform === 'darwin' || platform === 'linux'
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
 * Wrap a shell command in the platform sandbox, or undefined when the platform has none
 * (the caller then refuses to run it sandboxed rather than silently running it raw).
 */
export function sandboxArgv(command: string, opts: { platform: NodeJS.Platform; cwd: string; network: boolean }): string[] | undefined {
  if (opts.platform === 'darwin') {
    return ['sandbox-exec', '-p', darwinProfile(opts.cwd, opts.network), '/bin/bash', '-c', command]
  }
  if (opts.platform === 'linux') {
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
      opts.cwd,
      opts.cwd,
      '--tmpfs',
      '/tmp',
      '--die-with-parent',
      ...(opts.network ? [] : ['--unshare-net']),
      '--',
      '/bin/bash',
      '-c',
      command,
    ]
  }
  return undefined
}
